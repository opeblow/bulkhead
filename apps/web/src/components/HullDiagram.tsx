import { useEffect, useState } from "react";

/**
 * FIG. 1 — Hull cross-section. Three compartments, three employers. Water level = how much
 * of this week's payroll the employer's own wallet covers. A deposit fills C; B stays short.
 * Illustrative animation on the landing page; the console shows live data.
 */
const PHASES = [
  { a: 1, b: 0.76, c: 0, label: "Pricing each employer from its own wallet" },
  { a: 1, b: 0.76, c: 0, label: "Fjord & Pine is short. Kestrel has nothing yet." },
  { a: 1, b: 0.76, c: 1, label: "A deposit lands in Kestrel. Only Kestrel rises." },
  { a: 1, b: 0.76, c: 1, label: "Fjord & Pine still short. Nothing leaks across." },
  { a: 1, b: 1, c: 1, label: "Approved bridge from platform capital. Everyone paid." },
];

export function HullDiagram() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => (x + 1) % PHASES.length), 2600);
    return () => clearInterval(t);
  }, []);
  const p = PHASES[i]!;
  const W = 520;
  const top = 46;
  const bottom = 236;
  const depth = bottom - top;
  const xs = [40, 196, 324, 480];
  const comp = [
    { k: "A", short: "NORTHWIND", name: "Northwind", level: p.a, amt: "$24,000", need: "needs $11,980.72" },
    {
      k: "B",
      short: "FJORD & PINE",
      name: "Fjord & Pine",
      level: p.b,
      amt: i === 4 ? "$7,953" : "$6,000",
      need: "needs $7,952.83",
    },
    {
      k: "C",
      short: "KESTREL",
      name: "Kestrel",
      level: p.c,
      amt: p.c ? "$15,000" : "$0",
      need: "needs $8,280.39",
    },
  ];
  // Hull taper: sides slope inward toward the keel.
  const hull = `M24 ${top} H${W - 24} L${W - 64} ${bottom + 20} H64 Z`;

  return (
    <figure className="plate" style={{ margin: 0 }}>
      <div className="plate-head">
        <span className="fig">Fig. 1 · Section A–A</span>
        <span className="fig">Illustrative</span>
      </div>
      <svg
        viewBox={`0 0 ${W} 300`}
        width="100%"
        role="img"
        aria-label="Hull cross-section with three sealed compartments, one per employer"
      >
        <defs>
          <clipPath id="hull">
            <path d={hull} />
          </clipPath>
          <pattern
            id="hatch"
            width="6"
            height="6"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <line x1="0" y1="0" x2="0" y2="6" stroke="#15171A" strokeWidth="0.6" opacity="0.18" />
          </pattern>
        </defs>
        <g clipPath="url(#hull)">
          <rect x="0" y="0" width={W} height="300" fill="#FBFAF6" />
          {comp.map((c, idx) => {
            const x0 = xs[idx]!;
            const x1 = xs[idx + 1]!;
            const h = depth * c.level;
            const short = c.level > 0 && c.level < 1;
            return (
              <g key={c.k}>
                <rect
                  x={x0}
                  width={x1 - x0}
                  y={bottom + 20 - h - 20 * c.level}
                  height={h + 20 * c.level + 2}
                  fill={short ? "#F6EAD3" : "#E3EEE9"}
                  style={{ transition: "all 1.1s cubic-bezier(.2,.7,.1,1)" }}
                />
                <rect
                  x={x0}
                  width={x1 - x0}
                  y={bottom + 20 - h - 20 * c.level}
                  height="2"
                  fill={short ? "#A8690F" : "#1E6B5A"}
                  style={{ transition: "all 1.1s cubic-bezier(.2,.7,.1,1)" }}
                />
              </g>
            );
          })}
          <rect x="0" y={bottom + 4} width={W} height="40" fill="url(#hatch)" />
        </g>
        {/* required line for B */}
        <line
          x1={xs[1]! + 6}
          x2={xs[2]! - 6}
          y1={top + 2}
          y2={top + 2}
          stroke="#E0531F"
          strokeDasharray="4 4"
          strokeWidth="1.2"
          opacity={p.b < 1 ? 1 : 0}
          style={{ transition: "opacity .6s" }}
        />
        <path d={hull} fill="none" stroke="#15171A" strokeWidth="2" strokeLinejoin="round" />
        {[xs[1]!, xs[2]!].map((x) => (
          <g key={x}>
            <line x1={x} x2={x} y1={top} y2={bottom + 20} stroke="#15171A" strokeWidth="5" />
            <line x1={x} x2={x} y1={top - 12} y2={top - 2} stroke="#E0531F" strokeWidth="2" />
          </g>
        ))}
        {comp.map((c, idx) => {
          const cx = (xs[idx]! + xs[idx + 1]!) / 2;
          return (
            <g key={`l${c.k}`} fontFamily="IBM Plex Mono, monospace">
              <text x={cx} y={top + 26} textAnchor="middle" fontSize="9.5" fill="#868B91" letterSpacing="0.5">
                {c.k} · {c.short}
              </text>
              <text x={cx} y={top + 54} textAnchor="middle" fontSize="18" fill="#15171A">
                {c.amt}
              </text>
              <text x={cx} y={top + 72} textAnchor="middle" fontSize="9" fill="#4B5057">
                {c.need}
              </text>
            </g>
          );
        })}
        <text x="24" y="292" fontFamily="IBM Plex Mono, monospace" fontSize="11" fill="#4B5057">
          {p.label}
        </text>
      </svg>
    </figure>
  );
}
