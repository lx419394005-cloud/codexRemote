import './globals.css';

export const metadata = {
  title: 'Codex Remote',
  description: 'Next.js workspace for the Codex bridge UI',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
