import Link from "next/link";

export default function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="font-heading text-lg font-black tracking-[0.18em] text-gold">
      PADAWAN
    </Link>
  );
}
