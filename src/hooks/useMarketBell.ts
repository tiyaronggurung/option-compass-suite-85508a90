import { useEffect, useRef } from "react";
import { playMarketBell } from "@/lib/marketBell";

const BELL_KEY = "xaf_last_bell_date";

function getNyNow(): Date {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
}

function shouldRing(): boolean {
  const now = getNyNow();
  const day = now.getDay(); // 0=Sun, 1=Mon, … 6=Sat
  if (day === 0 || day === 6) return false; // weekend

  const hours = now.getHours();
  const minutes = now.getMinutes();
  const seconds = now.getSeconds();

  // Bell fires exactly at 9:30:00 – 9:30:59 window (one-minute window)
  if (hours !== 9 || minutes !== 30) return false;

  // Prevent double-ring on refresh within the same minute
  const todayStr = now.toISOString().split("T")[0];
  const lastBell = localStorage.getItem(BELL_KEY);
  if (lastBell === todayStr) return false;

  return true;
}

function markRung() {
  const todayStr = getNyNow().toISOString().split("T")[0];
  localStorage.setItem(BELL_KEY, todayStr);
}

export function useMarketBell() {
  const hasFiredRef = useRef(false);

  useEffect(() => {
    const check = () => {
      if (hasFiredRef.current) return;
      if (shouldRing()) {
        hasFiredRef.current = true;
        markRung();
        try {
          playMarketBell();
        } catch {
          // AudioContext may be suspended — that's ok
        }
      }
    };

    // Check immediately in case the user loads the page at 9:30 exactly
    check();

    // Poll every 5 seconds — lightweight and accurate enough
    const id = setInterval(check, 5000);

    return () => clearInterval(id);
  }, []);
}
