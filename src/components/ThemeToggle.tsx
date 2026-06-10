import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Props {
  className?: string;
  variant?: "ghost" | "outline";
  size?: "sm" | "icon";
}

export function ThemeToggle({ className, variant = "ghost", size = "icon" }: Props) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = mounted ? resolvedTheme === "dark" : true;
  const next = isDark ? "light" : "dark";

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => setTheme(next)}
      className={cn("h-8 w-8", className)}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}
