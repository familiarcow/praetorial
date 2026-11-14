// F4 (FUND4 SPEC §4.5): the deposit address (or memo) as a QR code. qrcode-generator (no deps); drawn as one SVG path built from
// the module grid (no HTML strings from the library), dark modules on a light quiet zone so phone cameras read it in dark mode too.
import React, { useMemo } from "react";
import qrcode from "qrcode-generator";

export function QrCode({ value, label, size = 168, ...rest }: { value: string; label: string; size?: number; [k: `data-${string}`]: unknown }) {
  const { path, n } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let d = "";
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { path: d, n: count + 8 };
  }, [value]);
  return (
    <svg {...(rest as object)} className="fund-qr" role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}
