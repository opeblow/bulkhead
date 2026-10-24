# Privacy

Bulkhead is a hackathon project that runs against the Airwallex **sandbox**. It is built to handle payroll data the way a production system should, and this note says what it touches and where it goes.

## Data in the demo

All people, companies, emails, addresses and bank accounts in this repository are synthetic. Account numbers are made up and paired with real public routing identifiers (sort codes, ABA routing numbers, BICs), because Airwallex validates those formats.

## What Bulkhead processes

| Data                                                   | Purpose                         | Where it goes                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Employer payroll instructions (CSV, email, Slack text) | Extract payroll lines and flags | Kept in memory; sent to Anthropic **only** if `ANTHROPIC_API_KEY` is set                                                                                                                                                                                                       |
| Contractor names, countries, payout currency           | Pricing and payouts             | Airwallex (beneficiaries, transfers)                                                                                                                                                                                                                                           |
| Contractor bank details                                | Creating beneficiaries          | Airwallex. Stored bank details are **not sent to the model**; the advisor gets names, currencies and amounts. If an employer's own message contains bank details ("Tom changed banks: sort code…"), that message is sent as written. The UI masks account numbers (`••••4590`) |
| Balances, transfers, ledger, audit trail               | Operating and proving the run   | In memory; the audit chain is appended to `BULKHEAD_DATA_DIR` as JSONL                                                                                                                                                                                                         |

## Model usage

When Claude is enabled, Bulkhead sends the minimum needed for each decision: the employer message being parsed (which may contain whatever the employer wrote), roster names and contract currencies, formatted amounts and options. Check Anthropic's commercial terms and data retention settings for your organisation before sending real personal data.

## Retention

Nothing is retained beyond the process except the audit JSONL in `BULKHEAD_DATA_DIR`. Delete that directory to remove it. A production deployment would define retention per jurisdiction (payroll records are often required for years) and encrypt at rest.

## Your rights

For a real deployment, employers act as data controllers for their contractors and the platform acts as a processor. This repository does not collect analytics, cookies or telemetry.

## Contact

Open a private security advisory (see [SECURITY.md](SECURITY.md)) for anything involving personal data.
