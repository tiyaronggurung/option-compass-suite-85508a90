import { Link } from "react-router-dom";
import { Activity, ArrowRight, Brain, LineChart, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DisclaimerBar } from "@/components/Disclaimer";

export default function Landing() {
  return (
    <div className="min-h-screen" style={{ backgroundImage: "var(--gradient-hero)" }}>
      <header className="container max-w-7xl py-5 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-md bg-primary/20 text-primary grid place-items-center">
            <Activity className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold">Tradingflow <span className="text-primary">101</span></span>
        </Link>
        <div className="flex items-center gap-2">
          <Link to="/auth"><Button variant="ghost" size="sm">Sign in</Button></Link>
          <Link to="/auth"><Button size="sm">Get started</Button></Link>
        </div>
      </header>

      <section className="container max-w-7xl pt-16 md:pt-24 pb-20">
        <div className="max-w-3xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-3 py-1 text-xs text-muted-foreground">
            <span className="pulse-dot" /> Educational paper-trading desk
          </span>
          <h1 className="mt-6 text-3xl sm:text-4xl md:text-6xl font-semibold tracking-tight leading-[1.1] break-words">
            Options signals,<br />
            <span className="text-primary">explained</span> before you click.
          </h1>
          <p className="mt-5 text-base sm:text-lg text-muted-foreground max-w-2xl">
            Watch live option-flow signals, see why each alert triggered, and approve manual paper trades from a single
            terminal. Built for research and learning — not financial advice.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/auth">
              <Button size="lg" className="neon-ring">
                Open the desk <ArrowRight className="h-4 w-4 ml-2" />
              </Button>
            </Link>
          </div>
        </div>

        <div className="mt-16 grid md:grid-cols-3 gap-4">
          <Feature icon={Activity} title="Live signals stream" body="A real-time feed of CALL/PUT alerts with confidence rings, risk badges, and contract ideas." />
          <Feature icon={Brain} title="Why it triggered" body="Plain-English reasoning, options flow, technical confirmation, and risk warnings (Phase 2)." />
          <Feature icon={LineChart} title="Paper trades only" body="Approve trades manually. Track entry, stop, target, and P/L without risking real capital." />
        </div>

        <div className="mt-12 max-w-3xl"><DisclaimerBar /></div>
      </section>

      <footer className="container max-w-7xl py-8 text-xs text-muted-foreground flex items-center gap-2">
        <ShieldCheck className="h-3.5 w-3.5" /> © Tradingflow 101 — educational use only.
      </footer>
    </div>
  );
}

function Feature({ icon: Icon, title, body }: any) {
  return (
    <div className="glass-card p-5">
      <div className="h-9 w-9 rounded-md bg-primary/15 text-primary grid place-items-center">
        <Icon className="h-4 w-4" />
      </div>
      <div className="mt-4 font-medium">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}
