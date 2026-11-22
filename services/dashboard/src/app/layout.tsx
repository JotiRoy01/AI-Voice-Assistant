import type { Metadata } from 'next';
import { AuthProvider } from '@/components/AuthContext';
import { AppShell } from '@/components/AppShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'FlowMind AI — Voice Order Confirmation Dashboard',
  description: 'Automated Bangla IVR/DTMF Order Confirmation & WhatsApp Instruction Console (SRS v1.0)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  );
}
