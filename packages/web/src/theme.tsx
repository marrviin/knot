/**
 * Shared provider shell for every renderer window (main app + settings window):
 * StyleProvider (cssinjs layering) + the knot ConfigProvider theme + AntdApp's
 * toast context. Extracted so a second BrowserWindow entry can mount antd
 * components with the exact same look without importing app.tsx (circular).
 */
import type { ReactNode } from "react";
import { App as AntdApp, ConfigProvider } from "antd";
import { StyleProvider } from "@ant-design/cssinjs";
import zhCN from "antd/locale/zh_CN";

export function ThemeProviders({ children }: { children: ReactNode }) {
  return (
    <StyleProvider layer>
      <ConfigProvider
        locale={zhCN}
        theme={{
          cssVar: { key: "knot" },
          token: {
            // Seed colors aligned with manta-compare: accent blue + brand functional colors.
            colorPrimary: "#3768fa",
            colorInfo: "#3768fa",
            colorSuccess: "#00b26f",
            colorWarning: "#f08433",
            colorError: "#f33b50",
            // Softer borders, rounder surfaces, light desktop/container backgrounds.
            colorBorder: "#e8e8ea",
            borderRadius: 12,
            borderRadiusSM: 8,
            borderRadiusXS: 6,
            colorBgLayout: "#f2f2f2",
            colorBgContainer: "#fafafa",
            controlItemBgActive: "rgba(0,0,0,0.06)",
          },
          components: {
            // Flat buttons — remove antd's default primary/default/danger button shadows.
            Button: {
              primaryShadow: "none",
              defaultShadow: "none",
              dangerShadow: "none",
            },
          },
        }}
      >
        <AntdApp message={{ top: 72 }}>{children}</AntdApp>
      </ConfigProvider>
    </StyleProvider>
  );
}
