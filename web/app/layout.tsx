import type { ReactNode } from "react";

export const metadata = {
  title: "ExamPro",
  description: "Secure. Fair. Transparent.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
