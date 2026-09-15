'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Seeded demo accounts, all with password "password123" (see
 * packages/db's seed script). Listed here purely as a development
 * convenience — see the notice rendered under the buttons below — never
 * as a pattern a real login page should follow.
 */
const SEEDED_ACCOUNTS = [
  { email: 'alice@example.com', password: 'password123', role: 'Customer' },
  { email: 'bob@example.com', password: 'password123', role: 'Customer' },
  { email: 'mod@example.com', password: 'password123', role: 'Moderator' },
] as const;

interface Credentials {
  email: string;
  password: string;
}

export function LoginForm(): ReactNode {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function signIn(credentials: Credentials): void {
    setError(null);
    startTransition(async () => {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? 'Sign in failed');
        return;
      }

      router.push('/');
      router.refresh();
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    signIn({ email, password });
  }

  return (
    <div className="space-y-6">
      <form className="space-y-4" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <Button type="submit" disabled={isPending} className="w-full">
          {isPending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>

      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">
          Development convenience only: these buttons sign in as a seeded account with one click. This is not a
          pattern for a real login page — a production login form never lists working credentials.
        </p>
        <div className="flex flex-wrap gap-2">
          {SEEDED_ACCOUNTS.map((account) => (
            <Button
              key={account.email}
              type="button"
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() => signIn(account)}
            >
              {account.role}: {account.email}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
