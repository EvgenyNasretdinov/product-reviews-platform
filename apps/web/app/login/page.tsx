import type { ReactNode } from 'react';
import { LoginForm } from '@/components/login-form';

export default function LoginPage(): ReactNode {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="mb-6 text-2xl font-semibold">Sign in</h1>
      <LoginForm />
    </main>
  );
}
