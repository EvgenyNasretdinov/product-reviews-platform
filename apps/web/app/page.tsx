import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { SignOutButton } from '@/components/sign-out-button';
import { getServerSession } from '@/lib/session';

export default async function HomePage(): Promise<ReactNode> {
  const user = await getServerSession();
  if (!user) {
    redirect('/login');
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <h1 className="text-2xl font-semibold">Signed in as {user.displayName}</h1>
      <p className="mt-2 text-muted-foreground">
        Role: {user.role}. The product catalogue lands in a later task.
      </p>
      <div className="mt-6">
        <SignOutButton />
      </div>
    </main>
  );
}
