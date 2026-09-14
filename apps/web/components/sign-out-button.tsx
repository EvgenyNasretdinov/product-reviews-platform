'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export function SignOutButton(): ReactNode {
  const router = useRouter();

  async function signOut(): Promise<void> {
    await fetch('/api/session', { method: 'DELETE' });
    router.push('/login');
    router.refresh();
  }

  return (
    <Button type="button" variant="outline" onClick={() => void signOut()}>
      Sign out
    </Button>
  );
}
