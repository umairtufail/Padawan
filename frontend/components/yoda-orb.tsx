type YodaOrbProps = {
  size?: number;
  label?: string;
  className?: string;
};

/** Yoda, the AI apprentice: a glowing green orb with an idle pulse. Our own art, no film imagery. */
export default function YodaOrb({ size = 220, label = "Yoda, the AI apprentice", className = "" }: YodaOrbProps) {
  return (
    <div
      role="img"
      aria-label={label}
      className={`yoda-orb rounded-full ${className}`}
      style={{
        width: size,
        height: size,
        background:
          "radial-gradient(circle at 35% 30%, #d8ffec 0%, #62f0a8 28%, #1f9d66 62%, #0a3b2a 100%)",
      }}
    />
  );
}
