import { useId } from "react";

type YodaFigureProps = {
  /** Width and height in px. */
  size?: number;
  label?: string;
  className?: string;
  /** Idle bobbing and blinking. Respects prefers-reduced-motion. */
  animated?: boolean;
};

/**
 * Baby Yoda, the AI apprentice. This is the same drawing used in the pitch slides (desk-pitch/index.html).
 * Our own stylised art, themed demo only: Star Wars and Yoda are trademarks of Lucasfilm / Disney.
 */
export default function YodaFigure({
  size = 240,
  label = "Yoda, the AI apprentice",
  className = "",
  animated = true,
}: YodaFigureProps) {
  // Gradient ids must be unique per instance, there can be several figures on one page.
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <div
      role="img"
      aria-label={label}
      className={`${animated ? "yoda-figure" : ""} ${className}`}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      <defs>
       <radialGradient id={`skin-${uid}`} cx="45%" cy="30%" r="75%"><stop offset="0" stopColor="#c4efae"/><stop offset="1" stopColor="#86cc7c"/></radialGradient>
       <radialGradient id={`glow-${uid}`} cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="#3dff8f" stopOpacity=".35"/><stop offset="1" stopColor="#3dff8f" stopOpacity="0"/></radialGradient>
       <g id={`ear-${uid}`}><path d="M128 205 C90 205 40 215 6 262 C30 178 85 140 140 156 Z" fill={`url(#skin-${uid})`} stroke="#4d9a4a" strokeWidth="3.5" strokeLinejoin="round"/>
        <path d="M122 202 C92 204 62 214 36 238" fill="none" stroke="#f6a9b8" strokeWidth="7" strokeLinecap="round" opacity=".75"/></g>
      </defs>
      <circle cx="200" cy="215" r="200" fill={`url(#glow-${uid})`}/>
      <path d="M120 400 C124 340 150 318 200 316 C250 318 276 340 280 400 Z" fill="#d9c4a1" stroke="#a98a62" strokeWidth="3"/>
      <path d="M165 322 L200 352 L235 322" fill="none" stroke="#a98a62" strokeWidth="4" strokeLinecap="round"/>
      <path d="M150 376 L250 376" stroke="#a98a62" strokeWidth="4" opacity=".5"/>
      <ellipse cx="146" cy="372" rx="18" ry="14" fill={`url(#skin-${uid})`} stroke="#4d9a4a" strokeWidth="3"/>
      <ellipse cx="254" cy="372" rx="18" ry="14" fill={`url(#skin-${uid})`} stroke="#4d9a4a" strokeWidth="3"/>
      <use href={`#ear-${uid}`} />
      <use href={`#ear-${uid}`} transform="translate(400 0) scale(-1 1)" />
      <ellipse cx="200" cy="210" rx="108" ry="104" fill={`url(#skin-${uid})`} stroke="#4d9a4a" strokeWidth="3.5"/>
      <path d="M192 108 C190 94 196 88 202 94 C206 86 214 90 210 108" fill="#f4faef" stroke="#cfe5c6" strokeWidth="2"/>
      <ellipse cx="127" cy="244" rx="20" ry="12" fill="#ff9db4" opacity=".6"/>
      <ellipse cx="273" cy="244" rx="20" ry="12" fill="#ff9db4" opacity=".6"/>
      <g className="yoda-eyes">
       <ellipse cx="155" cy="208" rx="30" ry="34" fill="#1b1230"/>
       <ellipse cx="245" cy="208" rx="30" ry="34" fill="#1b1230"/>
       <ellipse cx="155" cy="210" rx="22" ry="26" fill="#2c1d4d"/>
       <ellipse cx="245" cy="210" rx="22" ry="26" fill="#2c1d4d"/>
       <circle cx="145" cy="196" r="11" fill="#fff"/><circle cx="235" cy="196" r="11" fill="#fff"/>
       <circle cx="168" cy="222" r="5.5" fill="#fff" opacity=".9"/><circle cx="258" cy="222" r="5.5" fill="#fff" opacity=".9"/>
      </g>
      <circle cx="194" cy="238" r="2.5" fill="#4d9a4a"/><circle cx="206" cy="238" r="2.5" fill="#4d9a4a"/>
      <path d="M184 252 C192 262 208 262 216 252" stroke="#3a7d3a" strokeWidth="4" fill="none" strokeLinecap="round"/>
      </svg>
    </div>
  );
}
