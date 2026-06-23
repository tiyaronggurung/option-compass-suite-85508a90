import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { MarketRegime } from "@/lib/regimeAdjust";

export function useMarketRegime() {
  const [regime, setRegime] = useState<MarketRegime>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      const { data } = await supabase
        .from("market_regime")
        .select("regime")
        .eq("id", "global")
        .maybeSingle();
      if (cancel) return;
      const r = (data as any)?.regime as MarketRegime | undefined;
      setRegime(r ?? null);
    })();
    return () => { cancel = true; };
  }, []);

  return regime;
}
