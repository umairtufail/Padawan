import type { Metadata } from "next";
import { JetBrains_Mono, Montserrat } from "next/font/google";
import "./globals.css";
import AuthSync from "../components/auth-sync";
import CaptureIdentity from "../components/capture-identity";

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
  weight: ["700", "900"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Padawan: Teach Yoda what you know",
  description:
    "A voice apprentice that watches an expert's screen, asks why at the right pause, and trains the next hire.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${montserrat.variable} ${jetbrains.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <div className="starfield" aria-hidden="true" />
        <AuthSync />
        <CaptureIdentity />
        {children}
      </body>
    </html>
  );
}
