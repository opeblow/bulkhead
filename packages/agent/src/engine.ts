import { randomUUID } from "node:crypto";
import {
  AirwallexError,
  type AwxBeneficiaryPayload,
  type AwxEvent,
  PacedTransport,
  PlatformClient,
  RecordingTransport,
  type SimulatedAirwallex,
  type TenantClient,
  type Transport,
} from "@bulkhead/airwallex";
import {
  type Approval,
  type ApprovalSubject,
  AuditLog,
  add,
  type BankDetails,
  type Compartment,
  type Contractor,
  type ContractorId,
  type Currency,
  checkBinding,
  compartment,
  DEFAULT_FEES,
  DEFAULT_POLICY,
  dto,
  type Employer,
  evaluate,
  type FeeSchedule,
  type FxRate,
  format,
  isCurrency,
  isPositive,
  Ledger,
  type Money,
  operationRequestId,
  type PayrollLine,
  type PayrollQuote,
  type PolicyConfig,
  parseMoney,
  parseRate,
  planWithinCompartment,
  priceEmployerPayroll,
  type RateBook,
  requestApproval,
  sub,
  type TenantId,
  tenantId,
  toMajor,
  verifyChain,
  verifyIsolation,
  zero,
} from "@bulkhead/core";
import type { Advisor, ParsedBankChange, ShortfallOption } from "./advisor/types.js";
import { contractorFromSeed, type EmployerSeed, SCENARIO } from "./scenario.js";
import type {
  ApprovalDTO,
  LaneState,
  LineState,
  Proofs,
  QuoteDTO,
  RunOptions,
  RunState,
  Snapshot,
  TimelineItem,
  Tone,
} from "./state.js";

export interface BulkheadOptions {
  readonly transport: Transport;
  readonly advisor: Advisor;
  /** Milliseconds between visible steps. 0 in tests, ~600 for demos. */
  readonly pace?: number;
  readonly policy?: PolicyConfig;
  readonly fees?: FeeSchedule;
  readonly scenario?: readonly EmployerSeed[];
  /** Simulator instance when running offline; enables scripted events. */
  readonly simulator?: SimulatedAirwallex;
  /** Reuse existing connected accounts (sandbox mode), in scenario order. */
  readonly existingAccounts?: readonly string[];
  readonly onAudit?: (r: ReturnType<AuditLog["append"]>) => void;
}

interface Emp {
  readonly seed: EmployerSeed;
  readonly employer: Employer;
  readonly contractors: Map<ContractorId, Contractor>;
  globalAccountId?: string;
  opening: Map<Currency, Money>;
}

interface PendingBankChange {
  readonly contractorId: ContractorId;
  readonly change: ParsedBankChange;
  readonly approvalId: string;
}

type Waiter = { resolve: (v: string) => void };

/**
 * The Bulkhead engine. One run = one sealed pipeline per employer, executed concurrently.
 * Money decisions are made by @bulkhead/core (pricing + policy); the advisor only reads,
 * compares and explains. Every Airwallex call goes through a recorder so the console can
 * prove that customer-scoped calls carried the right x-on-behalf-of.
 */
export class Bulkhead {
  readonly recorder: RecordingTransport;
  readonly platform: PlatformClient;
  readonly ledger = new Ledger();
  readonly audit = new AuditLog();
  readonly advisor: Advisor;
  readonly policy: PolicyConfig;
  readonly fees: FeeSchedule;

  private readonly emps = new Map<TenantId, Emp>();
  private readonly order: TenantId[] = [];
  private readonly approvals = new Map<string, { approval: Approval; tenant: TenantId }>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly timeline: TimelineItem[] = [];
  private readonly listeners = new Set<(s: Snapshot) => void>();
  private readonly bridgeOutstanding = new Map<TenantId, Money>();
  private bridgeUsed: Money = zero("USD");
  private readonly issuedPayoutKeys = new Set<string>();
  private readonly pendingBankChanges = new Map<string, PendingBankChange>();
  private run: RunState | null = null;
  private runPromise: Promise<void> | null = null;
  private seq = 0;
  private version = 0;
  private emitTimer: NodeJS.Timeout | null = null;
  private bootstrapped = false;
  private proofsCache: Proofs | null = null;
  private platformBalances: Money[] = [];

  constructor(private readonly opts: BulkheadOptions) {
    // HttpTransport paces itself; anything else (the simulator) gets the same limits here.
    const paced = opts.transport.kind === "sandbox" ? opts.transport : new PacedTransport(opts.transport);
    this.recorder = new RecordingTransport(paced, { platformScopedAllowlist: [/^\/balances\/current$/] });
    this.platform = new PlatformClient(this.recorder);
    this.advisor = opts.advisor;
    this.policy = opts.policy ?? DEFAULT_POLICY;
    this.fees = opts.fees ?? DEFAULT_FEES;
    this.recorder.onRecord(() => this.changed());
    this.audit.onAppend((r) => opts.onAudit?.(r));
    opts.simulator?.onEvent((e) => this.onAirwallexEvent(e));
  }

  // ───────────────────────────── public surface ─────────────────────────────

  onChange(fn: (s: Snapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get scenario(): readonly EmployerSeed[] {
    return this.opts.scenario ?? SCENARIO;
  }

  tenantByKey(key: string): TenantId | undefined {
    return this.order.find((t) => this.emps.get(t)?.seed.key === key);
  }

  /** Create, submit and activate three employer connected accounts; open USD global accounts; seed deposits. */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    this.note(
      null,
      "platform.boot",
      "Bulkhead platform online",
      `Airwallex ${this.recorder.kind} · advisor ${this.advisor.kind}${this.advisor.model ? ` (${this.advisor.model})` : ""}`,
      "neutral",
    );
    for (const [i, seed] of this.scenario.entries()) {
      const existing = this.opts.existingAccounts?.[i];
      let id: string;
      if (existing) {
        id = existing;
        const acct = await this.platform.getAccount(id);
        if (acct.status !== "ACTIVE")
          throw new Error(`Connected account ${id} is ${acct.status}; activate it first`);
      } else {
        const acct = await this.platform.createAccount({
          nickname: seed.shortName,
          account_details: {
            business_details: {
              business_name: seed.legalName,
              business_identifiers: [
                {
                  country_code: "US",
                  number: `${88 + i}-${String(1000000 + i * 7919).slice(0, 7)}`,
                  type: "EIN",
                },
              ],
              industry_category_code: "ICCV3_0000XX",
              registration_address: {
                address_line1: "548 Market St",
                suburb: "San Francisco",
                state: "CA",
                postcode: "94104",
                country_code: "US",
              },
            },
            business_person_details: [
              {
                first_name: seed.contact.split("@")[0] ?? "ops",
                last_name: "Owner",
                roles: ["BENEFICIAL_OWNER", "AUTHORISED_PERSON"],
              },
            ],
          },
        });
        id = acct.id;
        await this.platform.submitAccount(id);
        await this.platform.simulateActivate(id);
      }
      const tenant = tenantId(id);
      const employer: Employer = {
        tenant,
        legalName: seed.legalName,
        shortName: seed.shortName,
        fundingCurrency: seed.fundingCurrency,
        country: "US",
        contact: seed.contact,
      };
      const contractors = new Map(
        seed.contractors.map((c) => {
          const ctr = contractorFromSeed(c, id);
          return [ctr.id, ctr] as const;
        }),
      );
      const emp: Emp = { seed, employer, contractors, opening: new Map() };
      this.emps.set(tenant, emp);
      this.order.push(tenant);
      const t = this.platform.forTenant(tenant);
      const gas = await t.listGlobalAccounts();
      const ga =
        gas.items.find((g) => g.currency === seed.fundingCurrency) ??
        (await t.createGlobalAccount({
          request_id: operationRequestId("ga", id, seed.fundingCurrency),
          country_code: "US",
          required_features: [{ currency: seed.fundingCurrency, transfer_method: "LOCAL" }],
        }));
      emp.globalAccountId = ga.id;
      const opening = await this.readCompartment(tenant);
      emp.opening = new Map(opening.balances);
      this.note(
        tenant,
        "employer.onboarded",
        `${seed.shortName} connected account active`,
        `${id} · USD global account ${ga.id}`,
        "airwallex",
      );
      if (seed.initialDeposit)
        await this.deposit(tenant, seed.initialDeposit, "Seed funding", { quiet: true });
    }
    this.platformBalances = (await this.platform.platformBalances()).flatMap((b) =>
      isCurrency(b.currency) ? [parseMoney(String(b.available_amount), b.currency)] : [],
    );
    this.bootstrapped = true;
    this.changed();
  }

  /** Start a payroll run across all employers. Resolves when the run is created; execution continues in the background. */
  async startRun(options: RunOptions = {}): Promise<string> {
    if (!this.bootstrapped) await this.bootstrap();
    if (this.run && this.run.status !== "complete") throw new Error("A run is already in progress");
    const id = `run_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${randomUUID().slice(0, 6)}`;
    this.run = {
      id,
      status: "running",
      startedAt: new Date().toISOString(),
      options,
      lanes: this.order.map((tenant) => {
        const e = this.emps.get(tenant)!;
        return {
          tenant,
          key: e.seed.key,
          legalName: e.seed.legalName,
          shortName: e.seed.shortName,
          status: "idle",
          statusText: "Queued",
          balances: [],
          lines: [],
          submission: { ...e.seed.submission },
        } satisfies LaneState;
      }),
    };
    this.note(
      null,
      "run.started",
      `Payroll run ${id} started`,
      "Three employers, three sealed compartments. Each employer's payroll is priced and paid only from its own wallet.",
      "agent",
    );
    const run = this.run;
    this.runPromise = (async () => {
      await Promise.all(
        run.lanes.map((lane) => this.runLane(run, lane).catch((e) => this.laneCrashed(lane, e))),
      );
      run.status = "complete";
      run.finishedAt = new Date().toISOString();
      this.proofsCache = await this.computeProofs();
      const p = this.proofsCache;
      this.note(
        null,
        "run.complete",
        `Run complete · ${this.countPaid(run)} paid, ${this.countHeld(run)} held, ${this.countFailed(run)} returned`,
        `Isolation ${p.isolation.ok ? "✓" : "✗"} · on-behalf-of coverage ${p.headerCoverage.tenantCalls - p.headerCoverage.missing}/${p.headerCoverage.tenantCalls} · reconciliation ${p.reconciliation.ok ? "✓" : "✗"} · audit chain ${p.auditChain.length} records ✓`,
        p.isolation.ok && p.reconciliation.ok && p.headerCoverage.ok ? "good" : "bad",
      );
      this.changed();
    })();
    this.changed();
    return id;
  }

  async waitForRun(): Promise<void> {
    await this.runPromise;
  }

  /** Simulate money landing in an employer's own wallet (sandbox deposit simulation). */
  async deposit(
    tenant: TenantId,
    amount: string,
    payer = "Employer top-up",
    opts: { quiet?: boolean } = {},
  ): Promise<void> {
    const emp = this.emp(tenant);
    const t = this.platform.forTenant(tenant);
    const m = parseMoney(amount, emp.employer.fundingCurrency);
    const others =
      this.run && this.run.status !== "complete" ? this.captureOthers(tenant) : new Map<TenantId, Money>();
    await t.simulateDeposit({
      global_account_id: emp.globalAccountId!,
      amount: toMajor(m),
      payer_name: payer,
    });
    this.ledger.post({
      kind: "deposit",
      tenant,
      memo: payer,
      legs: [
        { owner: "external", account: `payer:${payer}`, amount: { ...m, minor: -m.minor } },
        { owner: tenant, account: `wallet:${m.currency}`, amount: m },
      ],
    });
    const fresh = await this.readCompartment(tenant);
    this.refreshLaneBalances(tenant, fresh);
    if (!opts.quiet || this.run) {
      this.note(
        tenant,
        "deposit.landed",
        `${format(m)} landed in ${emp.seed.shortName}'s wallet`,
        `${payer} · credited to ${tenant} only`,
        "airwallex",
        { amount: dto(m) },
      );
    }
    if (others.size) await this.isolationCheckAfterDeposit(tenant, m, others);
    await this.collectBridgeRepayment(tenant);
    this.wake(`deposit:${tenant}`, "deposit");
    this.changed();
  }

  async decide(
    approvalId: string,
    decision: "approve" | "reject",
    by = "operator",
    note?: string,
  ): Promise<void> {
    const rec = this.approvals.get(approvalId);
    if (!rec) throw new Error(`Unknown approval ${approvalId}`);
    if (rec.approval.status !== "pending") throw new Error(`Approval is already ${rec.approval.status}`);
    rec.approval.status = decision === "approve" ? "approved" : "rejected";
    rec.approval.decidedAt = new Date().toISOString();
    rec.approval.decidedBy = by;
    rec.approval.note = note;
    this.note(
      rec.tenant,
      `approval.${rec.approval.status}`,
      `${by} ${decision === "approve" ? "approved" : "rejected"}: ${rec.approval.title}`,
      `Digest ${rec.approval.digest.slice(0, 16)}… binds ${rec.approval.subject.amount.display} · ${rec.approval.subject.counterparty}`,
      "operator",
    );
    this.wake(`approval:${approvalId}`, rec.approval.status);
    this.changed();
  }

  snapshot(): Snapshot {
    const balancesOf = (t: TenantId) => this.run?.lanes.find((l) => l.tenant === t)?.balances ?? [];
    const naive = this.order.reduce((acc, t) => {
      const usd = balancesOf(t).find((b) => b.currency === "USD");
      return usd ? add(acc, parseMoney(usd.amount, "USD")) : acc;
    }, zero("USD"));
    return {
      version: this.version,
      generatedAt: new Date().toISOString(),
      mode: { airwallex: this.recorder.kind, advisor: this.advisor.kind, model: this.advisor.model },
      bootstrapped: this.bootstrapped,
      platform: {
        tenant: "platform",
        balances: this.platformBalances.map(dto),
        bridgeCapital: dto(this.policy.bridgeCapital),
        bridgeUsed: dto(this.bridgeUsed),
        bridgeFloor: dto(this.policy.bridgeReserveFloor),
        bridgeOutstanding: [...this.bridgeOutstanding.entries()].map(([tenant, amount]) => ({
          tenant,
          amount: dto(amount),
        })),
      },
      employers: this.order.map((t) => {
        const e = this.emp(t);
        return {
          tenant: t,
          key: e.seed.key,
          legalName: e.seed.legalName,
          shortName: e.seed.shortName,
          balances: balancesOf(t),
          globalAccountId: e.globalAccountId,
          contractors: [...e.contractors.values()].map((c) => ({
            id: c.id,
            name: c.name,
            role: c.role,
            country: c.country,
            currency: c.payoutCurrency,
            method: c.method,
            bank: maskBank(c.bank),
          })),
        };
      }),
      run: this.run ? structuredClone(this.run) : null,
      approvals: [...this.approvals.values()].map(({ approval, tenant }) =>
        this.approvalDto(approval, tenant),
      ),
      timeline: this.timeline.slice(-400),
      calls: this.recorder.calls().slice(-500) as Snapshot["calls"],
      proofs: this.proofsCache,
      naiveAggregate: dto(naive),
      ledger: this.ledger.all().map((j) => ({
        id: j.id,
        at: j.at,
        kind: j.kind,
        tenant: j.tenant,
        memo: j.memo,
        legs: j.legs.map((l) => ({ owner: l.owner, account: l.account, amount: dto(l.amount) })),
      })),
    };
  }

  async proofs(): Promise<Proofs> {
    this.proofsCache = await this.computeProofs();
    this.changed();
    return this.proofsCache;
  }

  // ───────────────────────────── lane pipeline ─────────────────────────────

  private async runLane(run: RunState, lane: LaneState): Promise<void> {
    const tenant = tenantId(lane.tenant);
    const emp = this.emp(tenant);
    const roster = [...emp.contractors.values()].map((c) => ({
      name: c.name,
      payoutCurrency: c.payoutCurrency,
    }));

    // 1 · Intake: read the employer's unstructured instructions.
    this.setLane(
      lane,
      "intake",
      `Reading ${channelLabel(lane.submission.channel)} from ${emp.seed.shortName}`,
    );
    await this.pause(1);
    const parsed = await this.advisor.parseSubmission(emp.seed.submission.text, roster);
    lane.submission.parsed = parsed;
    const payroll: PayrollLine[] = [];
    for (const pl of parsed.lines) {
      const c = [...emp.contractors.values()].find(
        (x) => x.name.toLowerCase() === pl.contractorName.toLowerCase(),
      );
      if (!c) {
        this.note(
          tenant,
          "intake.unknown",
          `Ignored "${pl.contractorName}": not on ${emp.seed.shortName}'s roster`,
          undefined,
          "warn",
        );
        continue;
      }
      if (pl.currency !== c.payoutCurrency) {
        this.note(
          tenant,
          "intake.currency_mismatch",
          `${c.name}: ${pl.currency} requested but contracted in ${c.payoutCurrency}. Held for review.`,
          undefined,
          "warn",
        );
        continue;
      }
      const amount = parseMoney(pl.amount, c.payoutCurrency);
      payroll.push({
        contractorId: c.id,
        tenant,
        amount,
        memo: pl.memo ?? `Week 43 · ${emp.seed.shortName}`,
        dueDate: new Date().toISOString().slice(0, 10),
      });
      lane.lines.push(this.lineState(c, amount));
    }
    this.note(
      tenant,
      "intake.parsed",
      `Parsed ${payroll.length} payroll line${payroll.length === 1 ? "" : "s"} from ${emp.seed.shortName}'s ${channelLabel(lane.submission.channel)}`,
      [
        ...payroll.map((p) => `${emp.contractors.get(p.contractorId)?.name} ${format(p.amount)}`),
        ...parsed.notes,
      ].join(" · "),
      "agent",
      { source: parsed.source },
    );

    // Bank-detail changes are a payroll-redirection fraud vector: always a person's call.
    for (const change of parsed.bankChanges) {
      const c = [...emp.contractors.values()].find((x) => x.name === change.contractorName);
      const line = lane.lines.find((l) => l.contractorId === c?.id);
      if (!c || !line) continue;
      const fields = Object.entries(change)
        .filter(([k, v]) => k !== "contractorName" && v)
        .map(([k]) => k);
      const decision = evaluate(
        { kind: "beneficiary_change", tenant, contractorName: c.name, changedFields: fields },
        this.policy,
        this.policyState(),
      );
      const subject: ApprovalSubject = {
        action: "beneficiary_change",
        tenant,
        amount: line.amount,
        counterparty: c.name,
        terms: {
          bank: change.bankName ?? "unspecified",
          sort_code: change.sortCode
            ? `${change.sortCode.slice(0, 2)}-${change.sortCode.slice(2, 4)}-${change.sortCode.slice(4)}`
            : "",
          account: change.accountNumber ? `••••${change.accountNumber.slice(-4)}` : "",
          previous: maskBank(c.bank),
        },
        evidence: [`submission:${lane.submission.channel}:${lane.submission.receivedAt}`],
      };
      const approval = this.requestApprovalFor(
        tenant,
        subject,
        `Confirm new bank details for ${c.name}`,
        `${emp.seed.shortName}'s message says ${c.name.split(" ")[0]} moved to ${change.bankName ?? "a new bank"}. ${decision.reasons[0]} Pay ${line.amount.display} to the new account only after confirming by phone.`,
      );
      this.pendingBankChanges.set(c.id, { contractorId: c.id, change, approvalId: approval.id });
      line.status = "awaiting_approval";
      line.note = "New bank details need confirmation";
      this.note(
        tenant,
        "policy.bank_change",
        `Bank change for ${c.name} routed to a person`,
        decision.reasons.join(" "),
        "policy",
      );
    }
    this.changed();

    // 2 · Read this employer's compartment. Only this one.
    this.setLane(
      lane,
      "pricing",
      `Reading ${emp.seed.shortName}'s wallet with x-on-behalf-of: ${tenant.slice(0, 14)}…`,
    );
    let comp = await this.readCompartment(tenant);
    this.refreshLaneBalances(tenant, comp);
    await this.pause(1);

    const fundingCcy = emp.employer.fundingCurrency;
    if (!isPositive(comp.balances.get(fundingCcy) ?? zero(fundingCcy)) && payroll.length) {
      this.setLane(
        lane,
        "awaiting_funds",
        `${emp.seed.shortName} holds ${format(zero(fundingCcy))}. Waiting for its own deposit.`,
      );
      this.note(
        tenant,
        "lane.awaiting_funds",
        `${emp.seed.shortName} has no funds yet. Waiting for its own deposit, not borrowing.`,
        parsed.notes.join(" "),
        "agent",
      );
      if (run.options.scriptedDeposit !== false && emp.seed.midRunDeposit)
        this.scheduleScriptedDeposit(tenant, emp.seed.midRunDeposit);
      await this.waitFor(`deposit:${tenant}`);
      comp = await this.readCompartment(tenant);
      this.refreshLaneBalances(tenant, comp);
    }

    const eligible = payroll.filter((p) => !this.pendingBankChanges.has(p.contractorId));
    const rates = await this.rateBook(tenant, fundingCcy, payroll);
    const quote = priceEmployerPayroll({
      tenant,
      fundingCurrency: fundingCcy,
      lines: eligible,
      contractors: emp.contractors,
      compartment: comp,
      rates,
      fees: this.fees,
    });
    // The console shows the whole week's requirement, including lines waiting on a person.
    lane.quote = quoteDto(
      eligible.length === payroll.length
        ? quote
        : priceEmployerPayroll({
            tenant,
            fundingCurrency: fundingCcy,
            lines: payroll,
            contractors: emp.contractors,
            compartment: comp,
            rates,
            fees: this.fees,
          }),
    );
    this.note(
      tenant,
      "lane.priced",
      `${emp.seed.shortName}: needs ${format(quote.fundingRequired)}, holds ${format(quote.fundingAvailable)}`,
      `Payouts + SWIFT fees ${quote.requirements.map((r) => `${format(r.required)}`).join(" + ")} · platform fee ${format(quote.platformFee)}${quote.fundable ? "" : ` · short ${format(quote.shortfall)}`}`,
      quote.fundable ? "good" : "warn",
    );
    this.changed();
    await this.pause(1);

    let feeDue = zero(fundingCcy);
    if (eligible.length === 0) {
      // nothing to do until approvals land
    } else if (quote.fundable) {
      feeDue = add(feeDue, await this.executeLines(run, lane, eligible, quote));
    } else {
      feeDue = add(feeDue, await this.handleShortfall(run, lane, eligible, comp, quote, parsed.notes));
    }

    // 3 · Lines waiting on a bank-detail decision.
    for (const p of payroll.filter((x) => this.pendingBankChanges.has(x.contractorId))) {
      const pending = this.pendingBankChanges.get(p.contractorId)!;
      const line = lane.lines.find((l) => l.contractorId === p.contractorId)!;
      this.setLane(
        lane,
        "awaiting_approval",
        `Waiting for a person to confirm ${line.name}'s new bank details`,
      );
      const outcome = await this.waitFor(`approval:${pending.approvalId}`);
      this.pendingBankChanges.delete(p.contractorId);
      if (outcome !== "approved") {
        line.status = "held";
        line.note = "Bank change rejected; payout held";
        this.note(
          tenant,
          "line.held",
          `${line.name} held: new bank details not confirmed`,
          undefined,
          "warn",
        );
        continue;
      }
      const c = emp.contractors.get(p.contractorId)!;
      const bank: BankDetails = {
        ...c.bank,
        bankName: pending.change.bankName ?? c.bank.bankName,
        accountNumber: pending.change.accountNumber ?? c.bank.accountNumber,
        routingValue: pending.change.sortCode ?? c.bank.routingValue,
        iban: pending.change.iban ?? c.bank.iban,
      };
      const updated: Contractor = { ...c, bank, beneficiaryId: undefined };
      emp.contractors.set(c.id, updated);
      this.note(
        tenant,
        "contractor.updated",
        `${c.name}'s bank details updated after confirmation`,
        maskBank(bank),
        "operator",
      );
      const comp2 = await this.readCompartment(tenant);
      const q2 = priceEmployerPayroll({
        tenant,
        fundingCurrency: fundingCcy,
        lines: [p],
        contractors: emp.contractors,
        compartment: comp2,
        rates: await this.rateBook(tenant, fundingCcy, [p]),
        fees: this.fees,
      });
      if (q2.fundable) feeDue = add(feeDue, await this.executeLines(run, lane, [p], q2));
      else {
        line.status = "held";
        line.note = `Short ${format(q2.shortfall)} in ${emp.seed.shortName}'s own wallet`;
      }
    }

    // 4 · Platform fee, strictly after contractors.
    await this.collectFee(lane, tenant, feeDue);
    const anyHeld = lane.lines.some((l) => l.status === "held" || l.status === "failed");
    const anyPaid = lane.lines.some((l) => l.status === "paid");
    this.setLane(
      lane,
      anyHeld ? (anyPaid ? "partial" : "held") : "complete",
      anyHeld
        ? `${lane.lines.filter((l) => l.status === "paid").length} of ${lane.lines.length} paid`
        : "Everyone paid",
    );
    this.refreshLaneBalances(tenant, await this.readCompartment(tenant));
  }

  private async handleShortfall(
    run: RunState,
    lane: LaneState,
    lines: PayrollLine[],
    comp: Compartment,
    quote: PayrollQuote,
    notes: readonly string[],
  ): Promise<Money> {
    const tenant = tenantId(lane.tenant);
    const emp = this.emp(tenant);
    const ccy = emp.employer.fundingCurrency;
    const rates = await this.rateBook(tenant, ccy, lines);
    const partial = planWithinCompartment({
      tenant,
      fundingCurrency: ccy,
      lines,
      contractors: emp.contractors,
      compartment: comp,
      rates,
      fees: this.fees,
    });
    const name = (id: ContractorId) => emp.contractors.get(id)?.name ?? id;
    // Whole-dollar bridge: the extra cents stay in the employer's wallet and are repaid with the bridge.
    const bridgeAmt = ceilMajor(quote.shortfall);
    const bridgeDecision = evaluate(
      { kind: "bridge_advance", tenant, amount: bridgeAmt },
      this.policy,
      this.policyState(),
    );
    const richest = this.order
      .filter((t) => t !== tenant)
      .map((t) => ({ t, usd: this.laneUsd(t) }))
      .sort((a, b) => Number(b.usd.minor - a.usd.minor))[0];
    const borrowDecision = evaluate(
      { kind: "cross_tenant_transfer", from: richest?.t ?? tenant, to: tenant, amount: quote.shortfall },
      this.policy,
      this.policyState(),
    );

    this.setLane(lane, "short", `Short ${format(quote.shortfall)} in ${emp.seed.shortName}'s own wallet`);
    this.note(
      tenant,
      "lane.short",
      `${emp.seed.shortName} cannot fund the full batch from its own wallet`,
      `Needs ${format(quote.fundingRequired)} (SWIFT fees counted before conversion), holds ${format(quote.fundingAvailable)}. Shortfall ${format(quote.shortfall)}.`,
      "warn",
    );
    await this.pause(1);

    const options: ShortfallOption[] = [
      {
        id: "pay_priority_then_bridge",
        title: "Pay priority contractors now, bridge the rest",
        description: `Pay ${partial.paid.map(name).join(", ") || "nobody"} from ${emp.seed.shortName}'s own funds. Advance ${format(bridgeAmt)} of platform capital so ${partial.held.map(name).join(", ")} is paid today; repay from ${emp.seed.shortName}'s next deposit.`,
        payNow: partial.paid.map(name),
        hold: partial.held.map(name),
        amount: format(bridgeAmt),
        policy: bridgeDecision.outcome,
        policyReasons: bridgeDecision.reasons,
      },
      {
        id: "pay_priority_then_wait",
        title: "Pay priority contractors now, wait for top-up",
        description: `Pay ${partial.paid.map(name).join(", ") || "nobody"} now; hold ${partial.held.map(name).join(", ")} until ${emp.seed.shortName} deposits ${format(quote.shortfall)}.`,
        payNow: partial.paid.map(name),
        hold: partial.held.map(name),
        amount: format(quote.shortfall),
        policy: "allow",
        policyReasons: ["Uses only the employer's own funds."],
      },
      {
        id: "hold_all",
        title: "Hold the whole batch",
        description: "Pay nobody until the employer tops up.",
        payNow: [],
        hold: lines.map((l) => name(l.contractorId)),
        policy: "allow",
        policyReasons: ["Uses no funds."],
      },
      {
        id: "borrow_from_other_employer",
        title: `Cover the gap from ${richest ? this.emp(richest.t).seed.shortName : "another employer"}'s balance`,
        description: `The platform can technically move ${format(quote.shortfall)} out of ${richest ? this.emp(richest.t).seed.shortName : "another tenant"}'s wallet.`,
        payNow: lines.map((l) => name(l.contractorId)),
        hold: [],
        amount: format(quote.shortfall),
        policy: borrowDecision.outcome,
        policyReasons: borrowDecision.reasons.map((r) => this.humanize(r)),
      },
    ];
    lane.shortfall = { options };
    this.note(
      tenant,
      "policy.cross_tenant_denied",
      `Policy refused: cover ${emp.seed.shortName} with ${richest ? this.emp(richest.t).seed.shortName : "another employer"}'s funds`,
      borrowDecision.reasons.join(" "),
      "policy",
    );
    this.changed();

    const advice = await this.advisor.resolveShortfall({
      employer: emp.seed.shortName,
      employerNotes: notes,
      fundingAvailable: format(quote.fundingAvailable),
      fundingRequired: format(quote.fundingRequired),
      shortfall: format(quote.shortfall),
      lines: lines.map((l) => ({
        name: name(l.contractorId),
        amount: format(l.amount),
        method: emp.contractors.get(l.contractorId)!.method,
        priority: emp.contractors.get(l.contractorId)!.priority,
      })),
      options,
    });
    lane.shortfall.advice = advice;
    this.note(
      tenant,
      "agent.recommendation",
      `Recommendation: ${options.find((o) => o.id === advice.optionId)?.title}`,
      advice.rationale,
      "agent",
      { source: advice.source, employerMessage: advice.employerMessage },
    );
    this.changed();
    await this.pause(1);

    let feeDue = zero(ccy);
    const paidLines = lines.filter((l) => partial.paid.includes(l.contractorId));
    const heldLines = lines.filter((l) => partial.held.includes(l.contractorId));
    for (const l of heldLines) {
      const ls = lane.lines.find((x) => x.contractorId === l.contractorId)!;
      ls.status = "held";
      ls.note =
        advice.optionId === "pay_priority_then_bridge"
          ? "Held pending bridge approval"
          : "Held until employer tops up";
    }
    if (advice.optionId !== "hold_all" && paidLines.length && partial.quote) {
      feeDue = add(feeDue, await this.executeLines(run, lane, paidLines, partial.quote));
    } else {
      for (const l of paidLines) {
        const ls = lane.lines.find((x) => x.contractorId === l.contractorId)!;
        ls.status = "held";
      }
    }
    if (!heldLines.length) return feeDue;

    let outcome: string;
    let approvalId: string | undefined;
    if (advice.optionId === "pay_priority_then_bridge") {
      const subject = this.bridgeSubject(tenant, bridgeAmt, heldLines);
      const approval = this.requestApprovalFor(
        tenant,
        subject,
        `Bridge ${format(bridgeAmt)} to ${emp.seed.shortName}`,
        `Advance platform capital (never another employer's money) so ${heldLines.map((l) => name(l.contractorId)).join(", ")} ${heldLines.length === 1 ? "is" : "are"} paid today. Repaid automatically from ${emp.seed.shortName}'s next deposit.`,
      );
      approvalId = approval.id;
      lane.shortfall.bridgeApprovalId = approval.id;
      lane.bridge = { amount: dto(bridgeAmt), status: "requested" };
      this.setLane(lane, "awaiting_approval", `Waiting for approval to bridge ${format(bridgeAmt)}`);
      outcome = await Promise.race([
        this.waitFor(`approval:${approval.id}`),
        this.waitFor(`deposit:${tenant}`),
      ]);
    } else if (advice.optionId === "pay_priority_then_wait" || advice.optionId === "hold_all") {
      this.setLane(lane, "short", `Waiting for ${emp.seed.shortName} to top up ${format(quote.shortfall)}`);
      outcome = await this.waitFor(`deposit:${tenant}`);
    } else {
      outcome = "rejected";
    }

    if (outcome === "approved" && approvalId) {
      const rec = this.approvals.get(approvalId)!;
      const binding = checkBinding(rec.approval, this.bridgeSubject(tenant, bridgeAmt, heldLines));
      if (!binding.ok) {
        rec.approval.status = "stale";
        this.note(
          tenant,
          "approval.stale",
          "Approval no longer matches the action; asking again",
          binding.reason,
          "policy",
        );
        lane.bridge = { amount: dto(bridgeAmt), status: "rejected" };
      } else {
        await this.executeBridge(lane, tenant, bridgeAmt, approvalId);
        rec.approval.status = "executed";
      }
    } else if (outcome === "deposit") {
      if (approvalId) {
        const rec = this.approvals.get(approvalId)!;
        if (rec.approval.status === "pending") rec.approval.status = "stale";
        lane.bridge = { amount: dto(bridgeAmt), status: "superseded" };
        this.note(
          tenant,
          "approval.superseded",
          `${emp.seed.shortName}'s own top-up arrived first; bridge request withdrawn`,
          undefined,
          "agent",
        );
      }
    } else if (approvalId) {
      lane.bridge = { amount: dto(bridgeAmt), status: "rejected" };
    }

    const comp2 = await this.readCompartment(tenant);
    this.refreshLaneBalances(tenant, comp2);
    const q2 = priceEmployerPayroll({
      tenant,
      fundingCurrency: ccy,
      lines: heldLines,
      contractors: emp.contractors,
      compartment: comp2,
      rates: await this.rateBook(tenant, ccy, heldLines),
      fees: this.fees,
    });
    if (q2.fundable) {
      lane.shortfall.resolution =
        outcome === "approved" ? "Bridged with platform capital" : "Funded by the employer's own top-up";
      feeDue = add(feeDue, await this.executeLines(run, lane, heldLines, q2));
    } else {
      lane.shortfall.resolution = `Held: still short ${format(q2.shortfall)}`;
      for (const l of heldLines) {
        const ls = lane.lines.find((x) => x.contractorId === l.contractorId)!;
        ls.status = "held";
        ls.note = `Held: ${emp.seed.shortName} short ${format(q2.shortfall)}`;
      }
      this.note(
        tenant,
        "lane.held",
        `${heldLines.map((l) => name(l.contractorId)).join(", ")} held. ${emp.seed.shortName} notified with the exact top-up needed.`,
        advice.employerMessage,
        "warn",
      );
    }
    return feeDue;
  }

  private bridgeSubject(tenant: TenantId, amount: Money, held: PayrollLine[]): ApprovalSubject {
    const emp = this.emp(tenant);
    return {
      action: "bridge_advance",
      tenant,
      amount: dto(amount),
      counterparty: emp.seed.legalName,
      terms: {
        source: "Bulkhead platform capital",
        repayment: "First deposit into this employer's wallet",
        pays: held.map((l) => `${emp.contractors.get(l.contractorId)?.name} ${format(l.amount)}`).join("; "),
      },
      evidence: [`run:${this.run?.id}`, `shortfall:${format(amount)}`],
    };
  }

  private async executeBridge(
    lane: LaneState,
    tenant: TenantId,
    amount: Money,
    approvalId: string,
  ): Promise<void> {
    const emp = this.emp(tenant);
    const decision = evaluate({ kind: "bridge_advance", tenant, amount }, this.policy, this.policyState());
    if (decision.outcome === "deny") {
      this.note(
        tenant,
        "policy.denied",
        "Bridge denied at execution time",
        decision.reasons.join(" "),
        "policy",
      );
      lane.bridge = { amount: dto(amount), status: "rejected" };
      return;
    }
    const t = await this.platform.connectedAccountTransfer({
      request_id: operationRequestId("bridge", approvalId),
      amount: toMajor(amount),
      currency: amount.currency,
      destination: tenant,
      reason: "wages_salary",
      reference: `Bulkhead bridge ${this.run?.id ?? ""}`.slice(0, 35),
    });
    lane.bridge = { amount: dto(amount), status: "NEW", transferId: t.id };
    this.note(
      tenant,
      "bridge.created",
      `Bridge ${format(amount)} created · status NEW`,
      `connected_account_transfers ${t.id}. NEW is not final; polling until SETTLED.`,
      "airwallex",
    );
    this.changed();
    const settled = await this.pollUntil(
      () => this.platform.getConnectedAccountTransfer(t.id),
      (x) => x.status === "SETTLED" || x.status === "FAILED",
    );
    lane.bridge.status = settled.status === "SETTLED" ? "SETTLED" : "rejected";
    if (settled.status !== "SETTLED") return;
    this.ledger.post({
      kind: "bridge_advance",
      tenant,
      memo: `Bridge for ${emp.seed.shortName}`,
      ref: t.id,
      legs: [
        {
          owner: "platform",
          account: `wallet:${amount.currency}`,
          amount: { ...amount, minor: -amount.minor },
        },
        { owner: tenant, account: `wallet:${amount.currency}`, amount },
      ],
    });
    this.bridgeOutstanding.set(
      tenant,
      add(this.bridgeOutstanding.get(tenant) ?? zero(amount.currency), amount),
    );
    this.bridgeUsed = add(this.bridgeUsed, amount);
    this.note(
      tenant,
      "bridge.settled",
      `Bridge settled into ${emp.seed.shortName}'s wallet`,
      `Platform capital used ${format(this.bridgeUsed)} of ${format(this.policy.bridgeCapital)} · floor ${format(this.policy.bridgeReserveFloor)} intact`,
      "good",
    );
    await this.refreshPlatform();
  }

  private async collectBridgeRepayment(tenant: TenantId): Promise<void> {
    const owed = this.bridgeOutstanding.get(tenant);
    if (!owed || !isPositive(owed)) return;
    const comp = await this.readCompartment(tenant);
    const avail = comp.balances.get(owed.currency) ?? zero(owed.currency);
    const amount = avail.minor >= owed.minor ? owed : avail;
    if (!isPositive(amount)) return;
    const emp = this.emp(tenant);
    const c = await this.platform.charge({
      request_id: operationRequestId(
        "repay",
        tenant,
        toMajor(this.bridgeUsed),
        String(this.ledger.all().length),
      ),
      amount: toMajor(amount),
      currency: amount.currency,
      source: tenant,
      reason: "repayment",
      reference: "Bulkhead bridge repayment",
    });
    const done = await this.pollUntil(
      () => this.platform.getCharge(c.id),
      (x) => x.status === "SETTLED" || x.status === "FAILED",
    );
    if (done.status !== "SETTLED") return;
    this.ledger.post({
      kind: "bridge_repayment",
      tenant,
      memo: `Bridge repayment from ${emp.seed.shortName}`,
      ref: c.id,
      legs: [
        { owner: tenant, account: `wallet:${amount.currency}`, amount: { ...amount, minor: -amount.minor } },
        { owner: "platform", account: `wallet:${amount.currency}`, amount },
      ],
    });
    const left = sub(owed, amount);
    if (isPositive(left)) this.bridgeOutstanding.set(tenant, left);
    else this.bridgeOutstanding.delete(tenant);
    this.bridgeUsed = sub(this.bridgeUsed, amount);
    const lane = this.run?.lanes.find((l) => l.tenant === tenant);
    if (lane?.bridge && !isPositive(left)) lane.bridge.status = "repaid";
    this.note(
      tenant,
      "bridge.repaid",
      `${format(amount)} bridge repaid from ${emp.seed.shortName}'s own deposit`,
      `charges ${c.id} · SETTLED`,
      "good",
    );
    this.refreshLaneBalances(tenant, await this.readCompartment(tenant));
    await this.refreshPlatform();
  }

  /** Convert and pay a set of lines that the given quote says the employer can fund. Returns the platform fee earned. */
  private async executeLines(
    run: RunState,
    lane: LaneState,
    lines: PayrollLine[],
    quote: PayrollQuote,
  ): Promise<Money> {
    const tenant = tenantId(lane.tenant);
    const emp = this.emp(tenant);
    const t = this.platform.forTenant(tenant);
    this.setLane(
      lane,
      "executing",
      `Paying ${lines.length} contractor${lines.length === 1 ? "" : "s"} from ${emp.seed.shortName}'s wallet`,
    );

    for (const conv of quote.conversions) {
      const req = quote.requirements.find((r) => r.currency === conv.buy.currency)!;
      const decision = evaluate(
        {
          kind: "convert",
          tenant,
          sourceTenant: t.tenant,
          sell: conv.sell,
          buy: conv.buy,
          requiredInBuyCurrency: req.required,
          onHandInBuyCurrency: req.onHand,
        },
        this.policy,
        this.policyState(),
      );
      if (decision.outcome === "deny")
        throw new Error(`Policy denied conversion: ${decision.reasons.join(" ")}`);
      for (const l of lines) {
        const ls = lane.lines.find((x) => x.contractorId === l.contractorId)!;
        if (l.amount.currency === conv.buy.currency) ls.status = "converting";
      }
      this.changed();
      const q = await this.withFxRetry(tenant, () =>
        t.createQuote({
          sell_currency: conv.sell.currency,
          buy_currency: conv.buy.currency,
          buy_amount: toMajor(conv.buy),
        }),
      );
      const drift = evaluate(
        { kind: "rate_check", tenant, approvedRate: conv.fx.rate.text, currentRate: String(q.client_rate) },
        this.policy,
        this.policyState(),
      );
      if (drift.outcome !== "allow")
        this.note(
          tenant,
          "policy.quote_drift",
          "FX moved since pricing; re-sized to the locked quote",
          drift.reasons.join(" "),
          "policy",
        );
      const conversion = await this.withFxRetry(tenant, () =>
        t.convert({
          request_id: operationRequestId("fx", run.id, tenant, conv.buy.currency, toMajor(conv.buy)),
          sell_currency: conv.sell.currency,
          buy_currency: conv.buy.currency,
          buy_amount: toMajor(conv.buy),
          quote_id: q.quote_id,
        }),
      );
      const sold = parseMoney(String(conversion.sell_amount), conv.sell.currency);
      const bought = parseMoney(String(conversion.buy_amount), conv.buy.currency);
      this.ledger.post({
        kind: "conversion",
        tenant,
        memo: `FX ${format(sold)} → ${format(bought)} @ ${conversion.client_rate}`,
        ref: conversion.conversion_id,
        legs: [
          { owner: tenant, account: `wallet:${sold.currency}`, amount: { ...sold, minor: -sold.minor } },
          { owner: "external", account: "fx", amount: sold },
          { owner: "external", account: "fx", amount: { ...bought, minor: -bought.minor } },
          { owner: tenant, account: `wallet:${bought.currency}`, amount: bought },
        ],
      });
      // Confirm the conversion landed in THIS employer's wallet, not the platform's.
      const after = await this.readCompartment(tenant);
      this.refreshLaneBalances(tenant, after);
      const landed = after.balances.get(bought.currency) ?? zero(bought.currency);
      this.note(
        tenant,
        "fx.converted",
        `Converted ${format(sold)} → ${format(bought)} in ${emp.seed.shortName}'s wallet`,
        `Quote ${q.quote_id} @ ${conversion.client_rate}${isPositive(req.transferFees) ? ` · includes ${format(req.transferFees)} SWIFT fees` : ""} · landed balance ${format(landed)} (verified on ${tenant.slice(0, 12)}…)`,
        "airwallex",
      );
      await this.pause(1);
    }

    for (const l of lines) await this.payLine(run, lane, l);
    return quote.platformFee;
  }

  private async payLine(run: RunState, lane: LaneState, l: PayrollLine): Promise<void> {
    const tenant = tenantId(lane.tenant);
    const emp = this.emp(tenant);
    const t = this.platform.forTenant(tenant);
    const c = emp.contractors.get(l.contractorId)!;
    const ls = lane.lines.find((x) => x.contractorId === l.contractorId)!;
    ls.status = "paying";
    this.changed();

    const beneficiaryId = await this.ensureBeneficiary(t, c);
    ls.beneficiaryId = beneficiaryId;
    const payoutKey = `${run.id}:${c.id}`;
    const decision = evaluate(
      { kind: "payout", tenant, sourceTenant: t.tenant, payoutKey, amount: l.amount },
      this.policy,
      this.policyState(),
    );
    if (decision.outcome === "deny") {
      ls.status = "held";
      ls.note = decision.reasons.join(" ");
      this.note(tenant, "policy.denied", `Payout to ${c.name} blocked`, decision.reasons.join(" "), "policy");
      return;
    }
    const requestId = operationRequestId("payout", run.id, c.id);
    ls.requestId = requestId;
    let transfer: Awaited<ReturnType<TenantClient["createTransferOnce"]>>["transfer"];
    try {
      const res = await t.createTransferOnce({
        request_id: requestId,
        beneficiary_id: beneficiaryId,
        transfer_amount: toMajor(l.amount),
        transfer_currency: l.amount.currency,
        source_currency: l.amount.currency,
        transfer_method: c.method,
        reference: `${emp.seed.shortName} wk43`.slice(0, 30),
        reason: "wages_salary",
      });
      transfer = res.transfer;
      if (res.recovered)
        this.note(
          tenant,
          "transfer.recovered",
          `Recovered existing transfer for ${c.name} by request_id`,
          "Ambiguous response; looked up before retrying. No second payout.",
          "policy",
        );
    } catch (e) {
      ls.status = "held";
      ls.note = e instanceof AirwallexError ? `${e.code}: ${e.message}` : String(e);
      this.note(tenant, "transfer.error", `Payout to ${c.name} not created`, ls.note, "bad");
      return;
    }
    this.issuedPayoutKeys.add(payoutKey);
    ls.transferId = transfer.id;
    ls.status = "processing";
    const fee = parseMoney(String(transfer.fee_amount ?? 0), l.amount.currency);
    this.ledger.post({
      kind: "payout",
      tenant,
      memo: `${c.name} · ${c.method}`,
      ref: transfer.id,
      legs: [
        {
          owner: tenant,
          account: `wallet:${l.amount.currency}`,
          amount: { ...l.amount, minor: -(l.amount.minor + fee.minor) },
        },
        { owner: "external", account: `contractor:${c.id}`, amount: l.amount },
        ...(isPositive(fee)
          ? [{ owner: "external" as const, account: "airwallex:swift_fee", amount: fee }]
          : []),
      ],
    });
    this.note(
      tenant,
      "transfer.created",
      `Paying ${c.name} ${format(l.amount)} via ${c.method}`,
      `${transfer.id} · PROCESSING · request_id ${requestId.slice(0, 18)}…${isPositive(fee) ? ` · SWIFT fee ${format(fee)} from the same wallet` : ""}`,
      "airwallex",
    );
    this.changed();
    await this.pause(1);

    const fail = run.options.injectBankReturn && c.id === `ctr_${run.options.injectBankReturn}`;
    await t.simulateTransfer(transfer.id, "SENT");
    ls.status = "sent";
    this.changed();
    await this.pause(0.6);
    await t.simulateTransfer(transfer.id, fail ? "FAILED" : "PAID", fail ? "BANK_RETURN" : undefined);
    const final = await this.pollUntil(
      () => t.getTransfer(transfer.id),
      (x) => x.status === "PAID" || x.status === "CANCELLED",
    );
    if (final.status === "PAID") {
      ls.status = "paid";
      ls.note = ls.note?.includes("bridge")
        ? "Paid via approved bridge"
        : ls.note?.includes("bank")
          ? "Paid to confirmed new account"
          : undefined;
      this.note(
        tenant,
        "transfer.paid",
        `${c.name} paid ${format(l.amount)}`,
        `${transfer.id} · PAID`,
        "good",
      );
    } else {
      ls.status = "failed";
      this.ledger.post({
        kind: "payout_return",
        tenant,
        memo: `Returned: ${c.name}`,
        ref: transfer.id,
        legs: [
          {
            owner: "external",
            account: `contractor:${c.id}`,
            amount: { ...l.amount, minor: -l.amount.minor },
          },
          { owner: tenant, account: `wallet:${l.amount.currency}`, amount: l.amount },
        ],
      });
      const advice = await this.advisor.explainException({
        employer: emp.seed.shortName,
        contractor: c.name,
        amount: format(l.amount),
        failureType: final.failure_type ?? "unknown",
        failureReason: final.failure_reason ?? "unknown",
        feeLost: format(fee),
      });
      ls.failure = {
        type: final.failure_type ?? "unknown",
        reason: final.failure_reason ?? "",
        summary: advice.summary,
        nextSteps: advice.nextSteps,
      };
      this.note(
        tenant,
        "transfer.returned",
        `${c.name}'s payout came back (CANCELLED · ${final.failure_type})`,
        advice.summary,
        "bad",
        { nextSteps: advice.nextSteps },
      );
    }
    this.refreshLaneBalances(tenant, await this.readCompartment(tenant));
    this.changed();
  }

  private async ensureBeneficiary(t: TenantClient, c: Contractor): Promise<string> {
    if (c.beneficiaryId) return c.beneficiaryId;
    const payload = beneficiaryPayload(c);
    await t.validateBeneficiary(payload);
    const ben = await t.createBeneficiary(payload);
    c.beneficiaryId = ben.id;
    this.note(
      t.tenant,
      "beneficiary.created",
      `Beneficiary ready: ${c.name} (${c.country}, ${c.payoutCurrency}, ${c.method})`,
      `Validated then created under ${t.tenant.slice(0, 12)}… · ${ben.id}`,
      "airwallex",
    );
    return ben.id;
  }

  private async collectFee(lane: LaneState, tenant: TenantId, fee: Money): Promise<void> {
    const emp = this.emp(tenant);
    if (!isPositive(fee)) {
      lane.fee = { amount: dto(fee), status: "skipped" };
      return;
    }
    const payrollComplete = lane.lines.every((l) => ["paid", "held", "failed"].includes(l.status));
    const decision = evaluate(
      { kind: "charge_fee", tenant, amount: fee, payrollComplete },
      this.policy,
      this.policyState(),
    );
    lane.fee = { amount: dto(fee), status: "pending" };
    if (decision.outcome !== "allow") {
      lane.fee.status = "skipped";
      this.note(
        tenant,
        "policy.fee",
        `Platform fee not collected automatically`,
        decision.reasons.join(" "),
        "policy",
      );
      return;
    }
    this.setLane(lane, "settling_fee", `Collecting ${format(fee)} platform fee`);
    const c = await this.platform.charge({
      request_id: operationRequestId("fee", this.run?.id ?? "", tenant, toMajor(fee)),
      amount: toMajor(fee),
      currency: fee.currency,
      source: tenant,
      reason: "professional_business_services",
      reference: `Bulkhead fee ${this.run?.id ?? ""}`.slice(0, 35),
    });
    lane.fee = { amount: dto(fee), status: "NEW", chargeId: c.id };
    this.changed();
    const done = await this.pollUntil(
      () => this.platform.getCharge(c.id),
      (x) => x.status === "SETTLED" || x.status === "FAILED",
    );
    lane.fee.status = done.status === "SETTLED" ? "SETTLED" : "FAILED";
    if (done.status === "SETTLED") {
      this.ledger.post({
        kind: "platform_fee",
        tenant,
        memo: `Platform fee · ${emp.seed.shortName}`,
        ref: c.id,
        legs: [
          { owner: tenant, account: `wallet:${fee.currency}`, amount: { ...fee, minor: -fee.minor } },
          { owner: "platform", account: `wallet:${fee.currency}`, amount: fee },
        ],
      });
      this.note(
        tenant,
        "fee.settled",
        `Platform fee ${format(fee)} collected from ${emp.seed.shortName}`,
        `charges ${c.id} · NEW → SETTLED · collected after contractors`,
        "good",
      );
      await this.refreshPlatform();
    }
  }

  // ───────────────────────────── isolation demonstrations ─────────────────────────────

  /** Balances of every OTHER waiting/short employer, captured just before a deposit lands. */
  private captureOthers(depositTenant: TenantId): Map<TenantId, Money> {
    const out = new Map<TenantId, Money>();
    for (const lane of this.run?.lanes ?? []) {
      const t = tenantId(lane.tenant);
      if (t !== depositTenant && !["complete", "partial", "held", "idle"].includes(lane.status))
        out.set(t, this.laneUsd(t));
    }
    return out;
  }

  private async isolationCheckAfterDeposit(
    depositTenant: TenantId,
    amount: Money,
    before: Map<TenantId, Money>,
  ): Promise<void> {
    for (const [t, prior] of before) {
      const waiting = this.run?.lanes.find((l) => l.tenant === t);
      if (!waiting || !["short", "awaiting_approval", "awaiting_funds"].includes(waiting.status)) continue;
      const comp = await this.readCompartment(t);
      this.refreshLaneBalances(t, comp);
      const now = comp.balances.get("USD") ?? zero("USD");
      const lane = this.run?.lanes.find((l) => l.tenant === t);
      const naive = this.snapshot().naiveAggregate;
      const unchanged = now.minor === prior.minor;
      this.note(
        t,
        "isolation.recheck",
        `${this.emp(t).seed.shortName} re-read on its own: ${format(prior)} → ${format(now)}${unchanged ? " (unchanged)" : ""}`,
        `The ${format(amount)} deposit belongs to ${this.emp(depositTenant).seed.shortName}. ${lane?.quote && !lane.quote.fundable ? `${this.emp(t).seed.shortName} is still short ${lane.quote.shortfall.display}. ` : ""}Platform-wide the wallets now sum to ${naive.display}, a number Bulkhead never uses to fund payroll.`,
        "policy",
        { naiveAggregate: naive, before: dto(prior), after: dto(now) },
      );
    }
  }

  private scheduleScriptedDeposit(tenant: TenantId, amount: string): void {
    const delay = Math.max(50, (this.opts.pace ?? 0) * 14);
    setTimeout(() => {
      void this.deposit(tenant, amount, "Treasury wire").catch((e) =>
        this.note(tenant, "deposit.error", "Scripted deposit failed", String(e), "bad"),
      );
    }, delay);
  }

  // ───────────────────────────── plumbing ─────────────────────────────

  private onAirwallexEvent(e: AwxEvent): void {
    // The simulator emits webhook-shaped events; the API layer also feeds real webhooks here.
    if (e.name === "payout.transfer.failed") this.changed();
  }

  /** Feed a verified webhook event (real sandbox) into the engine. */
  ingestEvent(e: AwxEvent): void {
    this.onAirwallexEvent(e);
    this.note(e.account_id, `webhook.${e.name}`, `Webhook ${e.name}`, `event ${e.id}`, "airwallex");
  }

  private async rateBook(tenant: TenantId, sell: Currency, lines: PayrollLine[]): Promise<RateBook> {
    const t = this.platform.forTenant(tenant);
    const needed = [...new Set(lines.map((l) => l.amount.currency))].filter((c) => c !== sell);
    const book = new Map<string, FxRate>();
    for (const buy of needed) {
      const r = await this.withFxRetry(tenant, () =>
        this.recorder.send<{ rate: number }>({
          method: "GET",
          path: "/fx/rates/current",
          query: { sell_currency: sell, buy_currency: buy },
          onBehalfOf: t.tenant,
        }),
      );
      book.set(`${sell}/${buy}`, { sell, buy, rate: parseRate(r.rate.toFixed(6)), source: "indicative" });
    }
    return (s, b) => {
      const r = book.get(`${s}/${b}`);
      if (!r) throw new Error(`No rate for ${s}/${b}`);
      return r;
    };
  }

  /** FX on a freshly activated account can return unconfigured_client_fee for a few minutes. */
  private async withFxRetry<T>(tenant: TenantId, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (
          e instanceof AirwallexError &&
          (e.code === "unconfigured_client_fee" || e.status === 429) &&
          attempt < 12
        ) {
          if (attempt === 0)
            this.note(
              tenant,
              "fx.waiting",
              "FX not configured yet on a new account; retrying",
              e.message,
              "warn",
            );
          await sleep(e.status === 429 ? 400 : 15_000);
          continue;
        }
        throw e;
      }
    }
  }

  private async readCompartment(tenant: TenantId): Promise<Compartment> {
    const t = this.platform.forTenant(tenant);
    const rows = await t.balances();
    return compartment(
      tenant,
      rows.flatMap((r) =>
        isCurrency(r.currency)
          ? [[r.currency, parseMoney(String(r.available_amount), r.currency)] as [Currency, Money]]
          : [],
      ),
    );
  }

  private async refreshPlatform(): Promise<void> {
    this.platformBalances = (await this.platform.platformBalances()).flatMap((b) =>
      isCurrency(b.currency) ? [parseMoney(String(b.available_amount), b.currency)] : [],
    );
    this.changed();
  }

  private refreshLaneBalances(tenant: TenantId, comp: Compartment): void {
    const dtos = [...comp.balances.values()].filter((m) => m.minor !== 0n || m.currency === "USD").map(dto);
    if (!dtos.some((d) => d.currency === "USD")) dtos.unshift(dto(zero("USD")));
    dtos.sort((a, b) =>
      a.currency === "USD" ? -1 : b.currency === "USD" ? 1 : a.currency.localeCompare(b.currency),
    );
    const lane = this.run?.lanes.find((l) => l.tenant === tenant);
    if (lane) lane.balances = dtos;
    this.lastBalances.set(tenant, dtos);
    this.changed();
  }

  private readonly lastBalances = new Map<TenantId, ReturnType<typeof dto>[]>();

  private laneUsd(t: TenantId): Money {
    const usd = this.lastBalances.get(t)?.find((b) => b.currency === "USD");
    return usd ? parseMoney(usd.amount, "USD") : zero("USD");
  }

  private async pollUntil<T>(fn: () => Promise<T>, done: (x: T) => boolean, attempts = 40): Promise<T> {
    let last = await fn();
    for (let i = 0; i < attempts && !done(last); i++) {
      await sleep(Math.min(2000, 150 * 2 ** Math.min(i, 4)));
      last = await fn();
    }
    return last;
  }

  private requestApprovalFor(
    tenant: TenantId,
    subject: ApprovalSubject,
    title: string,
    summary: string,
  ): Approval {
    const approval = requestApproval(subject, title, summary);
    this.approvals.set(approval.id, { approval, tenant });
    this.note(tenant, "approval.requested", `Approval needed: ${title}`, summary, "operator", {
      approvalId: approval.id,
      digest: approval.digest,
    });
    return approval;
  }

  private approvalDto(a: Approval, tenant: TenantId): ApprovalDTO {
    return { ...a, subject: a.subject, tenantName: this.emp(tenant).seed.shortName };
  }

  private policyState() {
    return {
      bridgeOutstanding: this.bridgeOutstanding,
      bridgeCapitalUsed: this.bridgeUsed,
      issuedPayoutKeys: this.issuedPayoutKeys,
    };
  }

  private waitFor(key: string): Promise<string> {
    // An approval decided before anyone waited must not be lost.
    if (key.startsWith("approval:")) {
      const status = this.approvals.get(key.slice("approval:".length))?.approval.status;
      if (status && status !== "pending") return Promise.resolve(status);
    }
    return new Promise((resolve) => {
      const list = this.waiters.get(key) ?? [];
      list.push({ resolve });
      this.waiters.set(key, list);
    });
  }

  private wake(key: string, value: string): void {
    const list = this.waiters.get(key);
    this.waiters.delete(key);
    for (const w of list ?? []) w.resolve(value);
  }

  private emp(t: TenantId | string): Emp {
    const e = this.emps.get(t as TenantId);
    if (!e) throw new Error(`Unknown employer ${t}`);
    return e;
  }

  private lineState(c: Contractor, amount: Money): LineState {
    const feeStr = c.method === "SWIFT" ? this.fees.swift[c.payoutCurrency] : undefined;
    return {
      contractorId: c.id,
      name: c.name,
      role: c.role,
      country: c.country,
      method: c.method,
      amount: dto(amount),
      fee: dto(feeStr ? parseMoney(feeStr, c.payoutCurrency) : zero(c.payoutCurrency)),
      status: "queued",
    };
  }

  private setLane(lane: LaneState, status: LaneState["status"], text: string): void {
    lane.status = status;
    lane.statusText = text;
    if (this.run) {
      const waiting = this.run.lanes.some(
        (l) => l.status === "awaiting_approval" || l.status === "awaiting_funds" || l.status === "short",
      );
      if (this.run.status !== "complete") this.run.status = waiting ? "waiting" : "running";
    }
    this.changed();
  }

  private laneCrashed(lane: LaneState, e: unknown): void {
    lane.status = "held";
    lane.statusText = `Stopped safely: ${(e as Error).message}`;
    for (const l of lane.lines) if (!["paid", "failed"].includes(l.status)) l.status = "held";
    this.note(lane.tenant, "lane.error", `${lane.shortName} stopped safely`, (e as Error).message, "bad");
  }

  private note(
    tenant: string | null,
    kind: string,
    title: string,
    detail: string | undefined,
    tone: Tone,
    data?: unknown,
  ): void {
    title = this.humanize(title);
    detail = detail === undefined ? undefined : this.humanize(detail);
    const item: TimelineItem = {
      id: `tl_${++this.seq}`,
      seq: this.seq,
      at: new Date().toISOString(),
      tenant,
      kind,
      title,
      detail,
      tone,
      data,
    };
    this.timeline.push(item);
    const actor =
      tone === "agent"
        ? "agent"
        : tone === "policy"
          ? "policy"
          : tone === "operator"
            ? "operator"
            : tone === "airwallex"
              ? "airwallex"
              : "system";
    this.audit.append({
      kind,
      tenant,
      actor,
      message: title,
      data: { detail, ...(data && typeof data === "object" ? data : {}) },
      at: item.at,
    });
    this.changed();
  }

  /** Replace raw connected-account ids with employer names in human-facing text. */
  private humanize(text: string): string {
    let out = text;
    for (const [t, e] of this.emps)
      out = out.split(`${t}'s`).join(`${e.seed.shortName}'s`).split(t).join(e.seed.shortName);
    return out;
  }

  private pause(units = 1): Promise<void> {
    const ms = (this.opts.pace ?? 0) * units;
    return ms > 0 ? sleep(ms) : Promise.resolve();
  }

  private changed(): void {
    this.version++;
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (!this.listeners.size) return;
      const s = this.snapshot();
      for (const l of this.listeners) l(s);
    }, 40);
  }

  private countPaid(run: RunState) {
    return run.lanes.flatMap((l) => l.lines).filter((l) => l.status === "paid").length;
  }
  private countHeld(run: RunState) {
    return run.lanes
      .flatMap((l) => l.lines)
      .filter((l) => l.status === "held" || l.status === "awaiting_approval").length;
  }
  private countFailed(run: RunState) {
    return run.lanes.flatMap((l) => l.lines).filter((l) => l.status === "failed").length;
  }

  private async computeProofs(): Promise<Proofs> {
    const iso = verifyIsolation(this.ledger.all());
    const calls = this.recorder.calls().filter((c) => c.tenantScoped && c.scope === "tenant");
    const missing = this.recorder.calls().filter((c) => c.tenantScoped && !c.scopeOk).length;
    const chain = verifyChain(this.audit.all());
    const rows: Proofs["reconciliation"]["rows"] = [];
    for (const t of this.order) {
      const e = this.emp(t);
      const comp = await this.readCompartment(t);
      const currencies = new Set<Currency>([...comp.balances.keys(), ...e.opening.keys()]);
      for (const j of this.ledger.forTenant(t))
        for (const l of j.legs) if (l.owner === t) currencies.add(l.amount.currency);
      for (const ccy of currencies) {
        const expected = add(e.opening.get(ccy) ?? zero(ccy), this.ledger.walletNet(t, ccy));
        const actual = comp.balances.get(ccy) ?? zero(ccy);
        rows.push({
          tenant: t,
          name: e.seed.shortName,
          currency: ccy,
          expected: format(expected),
          actual: format(actual),
          ok: expected.minor === actual.minor,
        });
      }
    }
    const transfers = this.recorder.calls().filter((c) => c.path === "/transfers/create" && c.ok);
    const unique = new Set(transfers.map((c) => c.requestId)).size;
    return {
      isolation: { ok: iso.ok, journals: iso.journalsChecked, violations: iso.violations.length },
      headerCoverage: { ok: missing === 0, tenantCalls: calls.length, missing },
      auditChain: { ok: chain.ok, length: chain.length, head: chain.head },
      reconciliation: { ok: rows.every((r) => r.ok), rows },
      duplicatePayouts: { ok: unique === transfers.length, payouts: transfers.length, unique },
    };
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function ceilMajor(m: Money): Money {
  const unit = 100n; // whole currency unit for 2-dp currencies
  const minor = ((m.minor + unit - 1n) / unit) * unit;
  return { currency: m.currency, minor };
}

function channelLabel(c: string): string {
  return c === "csv" ? "CSV export" : c === "email" ? "email" : "Slack message";
}

export function maskBank(b: BankDetails): string {
  if (b.iban) return `${b.iban.slice(0, 4)} •••• ${b.iban.slice(-4)} · ${b.swiftCode ?? ""}`;
  if (b.routingType === "sort_code")
    return `${b.bankName ?? "UK bank"} · ${b.routingValue?.replace(/(\d{2})(\d{2})(\d{2})/, "$1-$2-$3")} · ••••${b.accountNumber?.slice(-4)}`;
  if (b.routingType === "aba") return `ABA ${b.routingValue} · ••••${b.accountNumber?.slice(-4)}`;
  return "on file";
}

export function beneficiaryPayload(c: Contractor): AwxBeneficiaryPayload {
  const [first, ...rest] = c.name.split(" ");
  const b = c.bank;
  let bank_details: Record<string, string>;
  if (c.method === "SWIFT") {
    bank_details = {
      bank_country_code: b.bankCountry,
      account_name: b.accountName,
      account_currency: c.payoutCurrency,
      iban: b.iban ?? "",
      swift_code: b.swiftCode ?? "",
    };
  } else if (b.routingType === "aba") {
    bank_details = {
      bank_country_code: "US",
      account_name: b.accountName,
      account_currency: "USD",
      account_number: b.accountNumber ?? "",
      account_routing_type1: "aba",
      account_routing_value1: b.routingValue ?? "",
      bank_account_category: b.accountCategory ?? "Checking",
    };
  } else {
    bank_details = {
      bank_country_code: "GB",
      account_name: b.accountName,
      account_currency: "GBP",
      bank_name: b.bankName ?? "",
      account_number: b.accountNumber ?? "",
      account_routing_type1: "sort_code",
      account_routing_value1: b.routingValue ?? "",
    };
  }
  return {
    beneficiary: {
      entity_type: "PERSONAL",
      first_name: first ?? c.name,
      last_name: rest.join(" ") || c.name,
      bank_details,
      address: {
        street_address: c.address.street,
        city: c.address.city,
        state: c.address.state,
        postcode: c.address.postcode,
        country_code: c.address.countryCode,
      },
    },
    transfer_methods: [c.method],
    nickname: `${c.name} (${c.tenant.slice(-6)})`,
  };
}

function quoteDto(q: PayrollQuote): QuoteDTO {
  return {
    fundingRequired: dto(q.fundingRequired),
    fundingAvailable: dto(q.fundingAvailable),
    shortfall: dto(q.shortfall),
    platformFee: dto(q.platformFee),
    grossInFunding: dto(q.grossInFunding),
    fundable: q.fundable,
    conversions: q.conversions.map((c) => ({
      buy: dto(c.buy),
      sell: dto(c.sell),
      rate: c.fx.rate.text,
      quoteId: c.fx.quoteId,
    })),
    requirements: q.requirements.map((r) => ({
      currency: r.currency,
      payouts: dto(r.payouts),
      transferFees: dto(r.transferFees),
      required: dto(r.required),
      onHand: dto(r.onHand),
      toBuy: dto(r.toBuy),
    })),
    asOf: q.compartmentAsOf,
  };
}
