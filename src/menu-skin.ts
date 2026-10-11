/**
 * Shared antd Menu skin used by both the sidebar (add project / project list) and
 * the settings modal's left navigation — corresponds to the .pc-menu-skin rules in
 * styles/antd.css. Row look aligns with manta-compare: 32px row height, 8px inline
 * padding, theme-tinted hover/selected background (controlItemBgActive — never the
 * primary color), neutral text. Values reference global antd CSS variables
 * (cssVar mode) and follow dark mode automatically. Usage: wrap the Menu in
 * <ConfigProvider theme={menuSkinTheme}> and add the `pc-menu-skin` class.
 */
import type { ThemeConfig } from 'antd';

export const menuSkinTheme: ThemeConfig = {
  components: {
    Menu: {
      itemBg: 'transparent',
      itemHeight: 32,
      itemMarginBlock: 0,
      itemMarginInline: 0,
      itemPaddingInline: 8,
      itemHoverBg: 'var(--ant-control-item-bg-active, rgba(0,0,0,0.06))',
      itemSelectedBg: 'var(--ant-control-item-bg-active, rgba(0,0,0,0.06))',
      // Selected item text stays neutral; never tint text with the primary color.
      itemSelectedColor: 'var(--ant-color-text)',
      iconMarginInlineEnd: 8,
      activeBarBorderWidth: 0,
    },
  },
};
