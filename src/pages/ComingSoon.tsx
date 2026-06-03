import { Sparkles } from "lucide-react";

export default function ComingSoon({ title }: { title: string }) {
  return (
    <div className="animate-fade-in">
      <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-10 glass-card p-12 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-primary/15 text-primary grid place-items-center">
          <Sparkles className="h-6 w-6" />
        </div>
        <div className="mt-4 font-medium">Shipping next</div>
        <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">
          This module is part of Phase 2 — coming after the Python trading engine is wired into the signals webhook.
        </p>
      </div>
    </div>
  );
}
