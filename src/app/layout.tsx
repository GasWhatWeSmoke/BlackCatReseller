import type { Metadata } from "next";
import "./globals.css";
import "./depth.css";
import { Nav } from "@/components/Nav";
import { Toaster } from "sonner";
import { DropZone } from "@/components/DropZone";
import { SoundEffects } from "@/components/SoundEffects";
import { NativeFixes } from "@/components/NativeFixes";
import { SurfaceMotion } from "@/components/SurfaceMotion";
import { DailyTheme } from "@/components/DailyTheme";
import { AmbientBackdrop } from "@/components/AmbientBackdrop";
import styles from "@/components/AppShell.module.css";

export const metadata: Metadata = {
  title: "Black Cat Reseller",
  description: "Your personal inventory, crosslisting, and sales workspace",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DailyTheme />
        <div className={styles.shell}>
          <AmbientBackdrop />
          <Nav />
          <main className={styles.content}>
            {children}
          </main>
        </div>
        <DropZone />
        <SoundEffects />
        <NativeFixes />
        <SurfaceMotion />
        <Toaster theme="dark" position="bottom-right" richColors />
      </body>
    </html>
  );
}
