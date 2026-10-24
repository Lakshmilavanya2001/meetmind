import { Logo } from "@/components/brand/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-muted/40 px-4 py-10">
      <Logo className="mb-8 text-lg" />
      <div className="w-full max-w-md">{children}</div>
    </main>
  );
}
