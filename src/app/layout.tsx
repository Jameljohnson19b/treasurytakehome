import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeskCheck — label checklist",
  description: "Check an alcohol label against the application. Close calls are left for an agent.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
