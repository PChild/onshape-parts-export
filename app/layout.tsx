import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Parts Exporter",
  description: "Send Onshape parts and faces to the classroom manufacturing queue.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
