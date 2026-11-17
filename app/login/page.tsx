import { redirect } from 'next/navigation';
import { basePath, getCurrentUser } from '@/lib/auth';
import LoginForm from './login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  if (await getCurrentUser()) redirect('/');
  return <LoginForm basePath={basePath()} />;
}
