export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      alert_settings: {
        Row: {
          bearish_only: boolean
          browser_push_enabled: boolean
          bullish_only: boolean
          cooldown_minutes: number
          discord_enabled: boolean
          discord_webhook_url: string | null
          email_enabled: boolean
          include_0dte: boolean
          max_risk_level: string
          min_confidence: number
          notify_email: string | null
          sms_enabled: boolean
          sms_phone: string | null
          telegram_chat_id: string | null
          telegram_enabled: boolean
          updated_at: string
          user_id: string
          watchlist_only: boolean
        }
        Insert: {
          bearish_only?: boolean
          browser_push_enabled?: boolean
          bullish_only?: boolean
          cooldown_minutes?: number
          discord_enabled?: boolean
          discord_webhook_url?: string | null
          email_enabled?: boolean
          include_0dte?: boolean
          max_risk_level?: string
          min_confidence?: number
          notify_email?: string | null
          sms_enabled?: boolean
          sms_phone?: string | null
          telegram_chat_id?: string | null
          telegram_enabled?: boolean
          updated_at?: string
          user_id: string
          watchlist_only?: boolean
        }
        Update: {
          bearish_only?: boolean
          browser_push_enabled?: boolean
          bullish_only?: boolean
          cooldown_minutes?: number
          discord_enabled?: boolean
          discord_webhook_url?: string | null
          email_enabled?: boolean
          include_0dte?: boolean
          max_risk_level?: string
          min_confidence?: number
          notify_email?: string | null
          sms_enabled?: boolean
          sms_phone?: string | null
          telegram_chat_id?: string | null
          telegram_enabled?: boolean
          updated_at?: string
          user_id?: string
          watchlist_only?: boolean
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          id: string
          signal_mode: Database["public"]["Enums"]["signal_view_mode"]
          updated_at: string
        }
        Insert: {
          id?: string
          signal_mode?: Database["public"]["Enums"]["signal_view_mode"]
          updated_at?: string
        }
        Update: {
          id?: string
          signal_mode?: Database["public"]["Enums"]["signal_view_mode"]
          updated_at?: string
        }
        Relationships: []
      }
      earnings_events: {
        Row: {
          created_at: string
          currency: string | null
          estimate: number | null
          fiscal_date_ending: string | null
          id: string
          report_date: string
          source: string
          ticker: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string | null
          estimate?: number | null
          fiscal_date_ending?: string | null
          id?: string
          report_date: string
          source?: string
          ticker: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string | null
          estimate?: number | null
          fiscal_date_ending?: string | null
          id?: string
          report_date?: string
          source?: string
          ticker?: string
          updated_at?: string
        }
        Relationships: []
      }
      insider_strength_scores: {
        Row: {
          as_of: string
          buy_count_30d: number
          buy_count_90d: number
          label: string
          score: number
          sell_count_30d: number
          sell_count_90d: number
          signals: Json
          ticker: string
          total_buy_value_90d: number
          updated_at: string
          window_days: number
        }
        Insert: {
          as_of?: string
          buy_count_30d?: number
          buy_count_90d?: number
          label?: string
          score?: number
          sell_count_30d?: number
          sell_count_90d?: number
          signals?: Json
          ticker: string
          total_buy_value_90d?: number
          updated_at?: string
          window_days?: number
        }
        Update: {
          as_of?: string
          buy_count_30d?: number
          buy_count_90d?: number
          label?: string
          score?: number
          sell_count_30d?: number
          sell_count_90d?: number
          signals?: Json
          ticker?: string
          total_buy_value_90d?: number
          updated_at?: string
          window_days?: number
        }
        Relationships: []
      }
      insider_transactions: {
        Row: {
          created_at: string
          direction: string
          external_ref: string | null
          filing_date: string | null
          id: string
          insider_name: string
          price: number | null
          raw: Json
          role: string | null
          shares: number | null
          source: string
          ticker: string
          total_value: number | null
          transaction_date: string
          transaction_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          direction: string
          external_ref?: string | null
          filing_date?: string | null
          id?: string
          insider_name: string
          price?: number | null
          raw?: Json
          role?: string | null
          shares?: number | null
          source?: string
          ticker: string
          total_value?: number | null
          transaction_date: string
          transaction_type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          direction?: string
          external_ref?: string | null
          filing_date?: string | null
          id?: string
          insider_name?: string
          price?: number | null
          raw?: Json
          role?: string | null
          shares?: number | null
          source?: string
          ticker?: string
          total_value?: number | null
          transaction_date?: string
          transaction_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      mark_engine_config: {
        Row: {
          enabled: boolean
          id: string
          updated_at: string
        }
        Insert: {
          enabled?: boolean
          id?: string
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      mark_engine_runs: {
        Row: {
          duration_ms: number | null
          error: string | null
          id: string
          missing_prices: string[]
          ran_at: string
          skipped_count: number
          status: string
          trigger: string
          updated_count: number
        }
        Insert: {
          duration_ms?: number | null
          error?: string | null
          id?: string
          missing_prices?: string[]
          ran_at?: string
          skipped_count?: number
          status: string
          trigger?: string
          updated_count?: number
        }
        Update: {
          duration_ms?: number | null
          error?: string | null
          id?: string
          missing_prices?: string[]
          ran_at?: string
          skipped_count?: number
          status?: string
          trigger?: string
          updated_count?: number
        }
        Relationships: []
      }
      market_regime: {
        Row: {
          details: Json
          id: string
          qqq_trend: number | null
          regime: string
          spy_trend: number | null
          updated_at: string
          vix_level: number | null
        }
        Insert: {
          details?: Json
          id?: string
          qqq_trend?: number | null
          regime?: string
          spy_trend?: number | null
          updated_at?: string
          vix_level?: number | null
        }
        Update: {
          details?: Json
          id?: string
          qqq_trend?: number | null
          regime?: string
          spy_trend?: number | null
          updated_at?: string
          vix_level?: number | null
        }
        Relationships: []
      }
      options_contracts: {
        Row: {
          ask: number | null
          bid: number | null
          created_at: string
          delta: number | null
          expiry: string
          gamma: number | null
          id: string
          iv: number | null
          last: number | null
          open_interest: number | null
          strike: number
          symbol: string
          theta: number | null
          type: string
          underlying: string
          updated_at: string
          vega: number | null
          volume: number | null
        }
        Insert: {
          ask?: number | null
          bid?: number | null
          created_at?: string
          delta?: number | null
          expiry: string
          gamma?: number | null
          id?: string
          iv?: number | null
          last?: number | null
          open_interest?: number | null
          strike: number
          symbol: string
          theta?: number | null
          type: string
          underlying: string
          updated_at?: string
          vega?: number | null
          volume?: number | null
        }
        Update: {
          ask?: number | null
          bid?: number | null
          created_at?: string
          delta?: number | null
          expiry?: string
          gamma?: number | null
          id?: string
          iv?: number | null
          last?: number | null
          open_interest?: number | null
          strike?: number
          symbol?: string
          theta?: number | null
          type?: string
          underlying?: string
          updated_at?: string
          vega?: number | null
          volume?: number | null
        }
        Relationships: []
      }
      paper_trades: {
        Row: {
          closed_at: string | null
          confidence_at_approval: number | null
          contract_idea: string | null
          current_pl: number
          current_pl_pct: number | null
          direction: Database["public"]["Enums"]["signal_direction"]
          entry_price: number | null
          exit_price: number | null
          exit_reason: Database["public"]["Enums"]["trade_close_reason"] | null
          id: string
          last_mark_at: string | null
          last_mark_price: number | null
          mae: number | null
          mark_source: string | null
          max_drawdown: number
          max_gain: number
          mfe: number | null
          opened_at: string
          paper_test_class: string | null
          realized_pl_pct: number | null
          risk_amount: number | null
          signal_id: string | null
          status: Database["public"]["Enums"]["trade_status"]
          stop_idea: number | null
          target_idea: number | null
          ticker: string
          user_id: string
        }
        Insert: {
          closed_at?: string | null
          confidence_at_approval?: number | null
          contract_idea?: string | null
          current_pl?: number
          current_pl_pct?: number | null
          direction: Database["public"]["Enums"]["signal_direction"]
          entry_price?: number | null
          exit_price?: number | null
          exit_reason?: Database["public"]["Enums"]["trade_close_reason"] | null
          id?: string
          last_mark_at?: string | null
          last_mark_price?: number | null
          mae?: number | null
          mark_source?: string | null
          max_drawdown?: number
          max_gain?: number
          mfe?: number | null
          opened_at?: string
          paper_test_class?: string | null
          realized_pl_pct?: number | null
          risk_amount?: number | null
          signal_id?: string | null
          status?: Database["public"]["Enums"]["trade_status"]
          stop_idea?: number | null
          target_idea?: number | null
          ticker: string
          user_id: string
        }
        Update: {
          closed_at?: string | null
          confidence_at_approval?: number | null
          contract_idea?: string | null
          current_pl?: number
          current_pl_pct?: number | null
          direction?: Database["public"]["Enums"]["signal_direction"]
          entry_price?: number | null
          exit_price?: number | null
          exit_reason?: Database["public"]["Enums"]["trade_close_reason"] | null
          id?: string
          last_mark_at?: string | null
          last_mark_price?: number | null
          mae?: number | null
          mark_source?: string | null
          max_drawdown?: number
          max_gain?: number
          mfe?: number | null
          opened_at?: string
          paper_test_class?: string | null
          realized_pl_pct?: number | null
          risk_amount?: number | null
          signal_id?: string | null
          status?: Database["public"]["Enums"]["trade_status"]
          stop_idea?: number | null
          target_idea?: number | null
          ticker?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "paper_trades_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      provider_configs: {
        Row: {
          enabled: boolean
          last_error: string | null
          last_status: Database["public"]["Enums"]["provider_status"]
          last_sync_at: string | null
          latency_ms: number | null
          mode: Database["public"]["Enums"]["provider_mode"]
          provider: Database["public"]["Enums"]["provider_id"]
          updated_at: string
        }
        Insert: {
          enabled?: boolean
          last_error?: string | null
          last_status?: Database["public"]["Enums"]["provider_status"]
          last_sync_at?: string | null
          latency_ms?: number | null
          mode?: Database["public"]["Enums"]["provider_mode"]
          provider: Database["public"]["Enums"]["provider_id"]
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          last_error?: string | null
          last_status?: Database["public"]["Enums"]["provider_status"]
          last_sync_at?: string | null
          latency_ms?: number | null
          mode?: Database["public"]["Enums"]["provider_mode"]
          provider?: Database["public"]["Enums"]["provider_id"]
          updated_at?: string
        }
        Relationships: []
      }
      risk_settings: {
        Row: {
          daily_loss_cap: number
          kill_switch: boolean
          max_open_trades: number
          max_risk_per_trade: number
          require_manual_approval: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          daily_loss_cap?: number
          kill_switch?: boolean
          max_open_trades?: number
          max_risk_per_trade?: number
          require_manual_approval?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          daily_loss_cap?: number
          kill_switch?: boolean
          max_open_trades?: number
          max_risk_per_trade?: number
          require_manual_approval?: boolean
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      scan_locks: {
        Row: {
          id: string
          locked_at: string
          locked_by: string | null
        }
        Insert: {
          id: string
          locked_at?: string
          locked_by?: string | null
        }
        Update: {
          id?: string
          locked_at?: string
          locked_by?: string | null
        }
        Relationships: []
      }
      scanner_settings: {
        Row: {
          debug_mode: boolean
          id: string
          profile: Database["public"]["Enums"]["scanner_profile"]
          universe_mode: Database["public"]["Enums"]["scanner_universe_mode"]
          updated_at: string
        }
        Insert: {
          debug_mode?: boolean
          id?: string
          profile?: Database["public"]["Enums"]["scanner_profile"]
          universe_mode?: Database["public"]["Enums"]["scanner_universe_mode"]
          updated_at?: string
        }
        Update: {
          debug_mode?: boolean
          id?: string
          profile?: Database["public"]["Enums"]["scanner_profile"]
          universe_mode?: Database["public"]["Enums"]["scanner_universe_mode"]
          updated_at?: string
        }
        Relationships: []
      }
      signal_actions: {
        Row: {
          action: Database["public"]["Enums"]["signal_action"]
          created_at: string
          id: string
          signal_id: string
          user_id: string
        }
        Insert: {
          action: Database["public"]["Enums"]["signal_action"]
          created_at?: string
          id?: string
          signal_id: string
          user_id: string
        }
        Update: {
          action?: Database["public"]["Enums"]["signal_action"]
          created_at?: string
          id?: string
          signal_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "signal_actions_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: false
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      signal_analyses: {
        Row: {
          bear_case: string | null
          bull_case: string | null
          catalyst_context: string | null
          created_at: string
          desks: Json
          flow_interpretation: string | null
          historical: Json
          macro_context: string | null
          model: string | null
          risk_warnings: string | null
          signal_id: string
          summary: string | null
          technical_confirmation: string | null
          verdict: string | null
          why_triggered: string | null
        }
        Insert: {
          bear_case?: string | null
          bull_case?: string | null
          catalyst_context?: string | null
          created_at?: string
          desks?: Json
          flow_interpretation?: string | null
          historical?: Json
          macro_context?: string | null
          model?: string | null
          risk_warnings?: string | null
          signal_id: string
          summary?: string | null
          technical_confirmation?: string | null
          verdict?: string | null
          why_triggered?: string | null
        }
        Update: {
          bear_case?: string | null
          bull_case?: string | null
          catalyst_context?: string | null
          created_at?: string
          desks?: Json
          flow_interpretation?: string | null
          historical?: Json
          macro_context?: string | null
          model?: string | null
          risk_warnings?: string | null
          signal_id?: string
          summary?: string | null
          technical_confirmation?: string | null
          verdict?: string | null
          why_triggered?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "signal_analyses_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: true
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      signal_outcomes: {
        Row: {
          confidence: number
          created_at: string
          direction: string
          entry_at: string
          entry_price: number | null
          last_error: string | null
          last_updated_at: string
          price_10d: number | null
          price_1d: number | null
          price_30d: number | null
          price_3d: number | null
          price_5d: number | null
          return_10d: number | null
          return_1d: number | null
          return_30d: number | null
          return_3d: number | null
          return_5d: number | null
          score_components: Json
          signal_id: string
          status: string
          ticker: string
          tier: string | null
          win_10d: boolean | null
          win_1d: boolean | null
          win_30d: boolean | null
          win_3d: boolean | null
          win_5d: boolean | null
        }
        Insert: {
          confidence: number
          created_at?: string
          direction: string
          entry_at: string
          entry_price?: number | null
          last_error?: string | null
          last_updated_at?: string
          price_10d?: number | null
          price_1d?: number | null
          price_30d?: number | null
          price_3d?: number | null
          price_5d?: number | null
          return_10d?: number | null
          return_1d?: number | null
          return_30d?: number | null
          return_3d?: number | null
          return_5d?: number | null
          score_components?: Json
          signal_id: string
          status?: string
          ticker: string
          tier?: string | null
          win_10d?: boolean | null
          win_1d?: boolean | null
          win_30d?: boolean | null
          win_3d?: boolean | null
          win_5d?: boolean | null
        }
        Update: {
          confidence?: number
          created_at?: string
          direction?: string
          entry_at?: string
          entry_price?: number | null
          last_error?: string | null
          last_updated_at?: string
          price_10d?: number | null
          price_1d?: number | null
          price_30d?: number | null
          price_3d?: number | null
          price_5d?: number | null
          return_10d?: number | null
          return_1d?: number | null
          return_30d?: number | null
          return_3d?: number | null
          return_5d?: number | null
          score_components?: Json
          signal_id?: string
          status?: string
          ticker?: string
          tier?: string | null
          win_10d?: boolean | null
          win_1d?: boolean | null
          win_30d?: boolean | null
          win_3d?: boolean | null
          win_5d?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "signal_outcomes_signal_id_fkey"
            columns: ["signal_id"]
            isOneToOne: true
            referencedRelation: "signals"
            referencedColumns: ["id"]
          },
        ]
      }
      signal_scan_runs: {
        Row: {
          avg_components: Json
          avg_score: number | null
          candidates_scanned: number
          duration_ms: number | null
          earnings_count: number | null
          error: string | null
          id: string
          profile: string | null
          ran_at: string
          signals_created: number
          skipped_candidates: Json
          skipped_count: number
          skipped_due_to_cap: number | null
          status: string
          threshold: number | null
          tickers_scanned: string[]
          trigger: string
          universe_count: number | null
          universe_mode: string | null
          watchlist_count: number | null
          would_have_created: number
        }
        Insert: {
          avg_components?: Json
          avg_score?: number | null
          candidates_scanned?: number
          duration_ms?: number | null
          earnings_count?: number | null
          error?: string | null
          id?: string
          profile?: string | null
          ran_at?: string
          signals_created?: number
          skipped_candidates?: Json
          skipped_count?: number
          skipped_due_to_cap?: number | null
          status: string
          threshold?: number | null
          tickers_scanned?: string[]
          trigger?: string
          universe_count?: number | null
          universe_mode?: string | null
          watchlist_count?: number | null
          would_have_created?: number
        }
        Update: {
          avg_components?: Json
          avg_score?: number | null
          candidates_scanned?: number
          duration_ms?: number | null
          earnings_count?: number | null
          error?: string | null
          id?: string
          profile?: string | null
          ran_at?: string
          signals_created?: number
          skipped_candidates?: Json
          skipped_count?: number
          skipped_due_to_cap?: number | null
          status?: string
          threshold?: number | null
          tickers_scanned?: string[]
          trigger?: string
          universe_count?: number | null
          universe_mode?: string | null
          watchlist_count?: number | null
          would_have_created?: number
        }
        Relationships: []
      }
      signals: {
        Row: {
          catalyst_summary: string | null
          confidence: number
          confidence_at_birth: number | null
          confirmation_label: string | null
          confirmation_score: number | null
          contract_symbol: string | null
          created_at: string
          direction: Database["public"]["Enums"]["signal_direction"]
          dte: number | null
          expires_at: string | null
          expiry: string | null
          external_id: string | null
          flow_at_birth: Json
          flow_metrics: Json
          hidden: boolean
          id: string
          is_demo: boolean
          lifecycle_history: Json
          lifecycle_reason: string | null
          lifecycle_state: string
          lifecycle_updated_at: string
          macro_score: number | null
          max_confidence_seen: number | null
          max_tier_seen: string | null
          min_confidence_seen: number | null
          min_tier_seen: string | null
          premium: number | null
          price: number | null
          reasons: Json
          risk_level: Database["public"]["Enums"]["risk_level"]
          score_components: Json
          source: string | null
          source_confirmations: Json
          status: Database["public"]["Enums"]["signal_status"]
          strike: number | null
          technical_at_birth: Json
          technical_metrics: Json
          ticker: string
          tier: string | null
        }
        Insert: {
          catalyst_summary?: string | null
          confidence: number
          confidence_at_birth?: number | null
          confirmation_label?: string | null
          confirmation_score?: number | null
          contract_symbol?: string | null
          created_at?: string
          direction: Database["public"]["Enums"]["signal_direction"]
          dte?: number | null
          expires_at?: string | null
          expiry?: string | null
          external_id?: string | null
          flow_at_birth?: Json
          flow_metrics?: Json
          hidden?: boolean
          id?: string
          is_demo?: boolean
          lifecycle_history?: Json
          lifecycle_reason?: string | null
          lifecycle_state?: string
          lifecycle_updated_at?: string
          macro_score?: number | null
          max_confidence_seen?: number | null
          max_tier_seen?: string | null
          min_confidence_seen?: number | null
          min_tier_seen?: string | null
          premium?: number | null
          price?: number | null
          reasons?: Json
          risk_level?: Database["public"]["Enums"]["risk_level"]
          score_components?: Json
          source?: string | null
          source_confirmations?: Json
          status?: Database["public"]["Enums"]["signal_status"]
          strike?: number | null
          technical_at_birth?: Json
          technical_metrics?: Json
          ticker: string
          tier?: string | null
        }
        Update: {
          catalyst_summary?: string | null
          confidence?: number
          confidence_at_birth?: number | null
          confirmation_label?: string | null
          confirmation_score?: number | null
          contract_symbol?: string | null
          created_at?: string
          direction?: Database["public"]["Enums"]["signal_direction"]
          dte?: number | null
          expires_at?: string | null
          expiry?: string | null
          external_id?: string | null
          flow_at_birth?: Json
          flow_metrics?: Json
          hidden?: boolean
          id?: string
          is_demo?: boolean
          lifecycle_history?: Json
          lifecycle_reason?: string | null
          lifecycle_state?: string
          lifecycle_updated_at?: string
          macro_score?: number | null
          max_confidence_seen?: number | null
          max_tier_seen?: string | null
          min_confidence_seen?: number | null
          min_tier_seen?: string | null
          premium?: number | null
          price?: number | null
          reasons?: Json
          risk_level?: Database["public"]["Enums"]["risk_level"]
          score_components?: Json
          source?: string | null
          source_confirmations?: Json
          status?: Database["public"]["Enums"]["signal_status"]
          strike?: number | null
          technical_at_birth?: Json
          technical_metrics?: Json
          ticker?: string
          tier?: string | null
        }
        Relationships: []
      }
      tradable_universe: {
        Row: {
          active: boolean
          asset_class: string | null
          avg_volume: number | null
          company_name: string | null
          exchange: string | null
          last_price: number | null
          market_cap: number | null
          optionable: boolean
          ticker: string
          tradable: boolean
          updated_at: string
        }
        Insert: {
          active?: boolean
          asset_class?: string | null
          avg_volume?: number | null
          company_name?: string | null
          exchange?: string | null
          last_price?: number | null
          market_cap?: number | null
          optionable?: boolean
          ticker: string
          tradable?: boolean
          updated_at?: string
        }
        Update: {
          active?: boolean
          asset_class?: string | null
          avg_volume?: number | null
          company_name?: string | null
          exchange?: string | null
          last_price?: number | null
          market_cap?: number | null
          optionable?: boolean
          ticker?: string
          tradable?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      trade_reviews: {
        Row: {
          created_at: string
          entry_quality: string | null
          id: string
          lessons: string | null
          model: string | null
          rr_quality: string | null
          signal_strength: string | null
          summary: string | null
          timing: string | null
          trade_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          entry_quality?: string | null
          id?: string
          lessons?: string | null
          model?: string | null
          rr_quality?: string | null
          signal_strength?: string | null
          summary?: string | null
          timing?: string | null
          trade_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          entry_quality?: string | null
          id?: string
          lessons?: string | null
          model?: string | null
          rr_quality?: string | null
          signal_strength?: string | null
          summary?: string | null
          timing?: string | null
          trade_id?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      watchlist_items: {
        Row: {
          created_at: string
          enable_0dte: boolean
          id: string
          min_confidence: number
          ticker: string
          user_id: string
        }
        Insert: {
          created_at?: string
          enable_0dte?: boolean
          id?: string
          min_confidence?: number
          ticker: string
          user_id: string
        }
        Update: {
          created_at?: string
          enable_0dte?: boolean
          id?: string
          min_confidence?: number
          ticker?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "user"
      provider_id:
        | "alpaca"
        | "tradier"
        | "polygon"
        | "unusual_whales"
        | "news"
        | "alpha_vantage"
        | "x_twitter"
        | "reddit"
        | "polymarket"
        | "kalshi"
        | "finviz"
        | "finnhub"
        | "apify"
      provider_mode: "live" | "simulated"
      provider_status: "ok" | "error" | "unknown"
      risk_level: "LOW" | "MEDIUM" | "HIGH"
      scanner_profile: "conservative" | "balanced" | "active_mvp" | "testing"
      scanner_universe_mode:
        | "base_8"
        | "watchlist_earnings"
        | "top_100"
        | "top_250"
        | "top_500"
      signal_action: "approved" | "dismissed"
      signal_direction: "CALL" | "PUT"
      signal_status: "LIVE" | "EXPIRED" | "TRIGGERED"
      signal_view_mode: "demo" | "live" | "both"
      trade_close_reason:
        | "target_hit"
        | "stop_hit"
        | "manual_close"
        | "expired"
        | "invalidated"
      trade_status: "OPEN" | "WIN" | "LOSS" | "CLOSED"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "user"],
      provider_id: [
        "alpaca",
        "tradier",
        "polygon",
        "unusual_whales",
        "news",
        "alpha_vantage",
        "x_twitter",
        "reddit",
        "polymarket",
        "kalshi",
        "finviz",
        "finnhub",
        "apify",
      ],
      provider_mode: ["live", "simulated"],
      provider_status: ["ok", "error", "unknown"],
      risk_level: ["LOW", "MEDIUM", "HIGH"],
      scanner_profile: ["conservative", "balanced", "active_mvp", "testing"],
      scanner_universe_mode: [
        "base_8",
        "watchlist_earnings",
        "top_100",
        "top_250",
        "top_500",
      ],
      signal_action: ["approved", "dismissed"],
      signal_direction: ["CALL", "PUT"],
      signal_status: ["LIVE", "EXPIRED", "TRIGGERED"],
      signal_view_mode: ["demo", "live", "both"],
      trade_close_reason: [
        "target_hit",
        "stop_hit",
        "manual_close",
        "expired",
        "invalidated",
      ],
      trade_status: ["OPEN", "WIN", "LOSS", "CLOSED"],
    },
  },
} as const
