// Lucide icons served by the local server, inlined as CSS masks so they take currentColor.

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <span
      className="icon"
      aria-hidden
      style={{
        width: size,
        height: size,
        WebkitMaskImage: `url(/api/lucide/${name}.svg)`,
        maskImage: `url(/api/lucide/${name}.svg)`,
      }}
    />
  );
}
