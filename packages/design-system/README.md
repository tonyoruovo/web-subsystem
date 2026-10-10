# @webkrnl/design-system

> **Release candidate (`0.1.0-rc.2`).** Published to [GitHub Packages](https://github.com/orgs/webkrnl/packages/npm/package/design-system) and [JSR](https://jsr.io/@webkrnl/design-system).

The **Design System** subsystem (id `design-system`, featurized, Page scope, no required dependency). It gives the page its **design tokens** and its **theme**, as CSS custom properties (`--ds-*`) and attributes on `<html>`. It has no components and no framework dependency: components of any framework read the custom properties.

- **Tokens**: colors, space, radii, type, shadows, motion and layers, with modes for dark, more contrast and density. The default set meets WCAG 2.2 AA for text in both color schemes, and AAA with more contrast.
- **The theme** comes from the appearance preferences of the user (Settings), the preferences of the device (`prefers-color-scheme`, `prefers-contrast`, `prefers-reduced-motion`), and the locale (Translation: `dir` and `lang`).
- **Live**: a change of a preference, of the device or of the locale writes only the properties that changed, once in a frame.
- **Every tab follows**: with Settings, the preferences are kept and shared by every tab of the site.
- **No flash of the wrong theme**: `renderThemeCss` and `renderThemeScript` go in the `<head>`, so the first paint is right before the platform starts.

Design: [ARCHITECTURE §21.4](../../docs/ARCHITECTURE.md#214-design-system) and the [Design System proposal](../../docs/proposals/design-system_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@webkrnl/core": "workspace:*",
    "@webkrnl/settings": "workspace:*",
    "@webkrnl/design-system": "workspace:*"
  }
}
```

## Entry points

| Import                   | Contents                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@webkrnl/design-system` | `createDesignSystem`, `DEFAULT_TOKENS`, `token`, `cssVar`, `checkTokens`, `contrastRatio`, `APPEARANCE_SETTINGS`, `APPEARANCE_KEYS`, `DEFAULT_APPEARANCE`, `resolveTheme`, `themeValues`, `renderThemeCss`, `renderThemeScript`, types |

## Usage

In the `<head>` (rendered at build time or by the server):

```ts
import { DEFAULT_TOKENS, renderThemeCss, renderThemeScript } from '@webkrnl/design-system';

const head = `<style>${renderThemeCss(DEFAULT_TOKENS)}</style>${renderThemeScript(DEFAULT_TOKENS, { nonce })}`;
```

In the app:

```ts
import {
  APPEARANCE_SETTINGS,
  createDesignSystem,
  type DesignSystemControl,
} from '@webkrnl/design-system';

const kernel = new Kernel(
  [
    ...centralized,
    createConsent(),
    createSettings({ definitions: APPEARANCE_SETTINGS }),
    createTranslation(options),
    createDesignSystem(),
  ],
  { router: queue.router, persistence },
);
await kernel.start();

const ds = kernel.unit<DesignSystemControl>('design-system').control!;
darkSwitch.onchange = () =>
  ds.commands.setAppearance({ colorScheme: darkSwitch.checked ? 'dark' : 'light' });
const end = ds.commands.preview({ fontScale: 1.25 }); // a settings page tries a value; end() undoes it
```

In CSS:

```css
.button {
  background: var(--ds-color-primary);
  color: var(--ds-color-on-primary);
  padding: var(--ds-space-2) var(--ds-space-4);
  border-radius: var(--ds-radius-md);
  font: var(--ds-font-weight-medium) var(--ds-font-size-md) / var(--ds-line-height-tight)
    var(--ds-font-family-sans);
  transition: background var(--ds-motion-duration-fast) var(--ds-motion-easing-standard);
  margin-inline-start: var(
    --ds-space-2
  ); /* logical properties: right to left needs no other token */
}
:root[data-color-scheme='dark'] .logo {
  filter: invert(1);
}
```

## Appearance preferences

| Preference      | Settings key               | Values                               | Default       |
| --------------- | -------------------------- | ------------------------------------ | ------------- |
| `colorScheme`   | `appearance.colorScheme`   | `system`, `light`, `dark`            | `system`      |
| `contrast`      | `appearance.contrast`      | `system`, `normal`, `more`           | `system`      |
| `density`       | `appearance.density`       | `compact`, `comfortable`, `spacious` | `comfortable` |
| `fontScale`     | `appearance.fontScale`     | 0.875 to 1.5                         | `1`           |
| `reducedMotion` | `appearance.reducedMotion` | `system`, `reduce`, `no-preference`  | `system`      |

All are `device` settings: they stay after sign-out.

## Behaviour

| Situation                                                 | Result                                                                                                                                                                                                |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start                                                     | Resolves the theme and writes it at once: every `--ds-*` property, `color-scheme`, and the attributes `data-color-scheme`, `data-contrast`, `data-density`, `data-reduced-motion`, `dir`, `lang`      |
| A preference is `system`                                  | The media query of the device decides, and a change of the device changes the theme                                                                                                                   |
| `setAppearance` with Settings (and `APPEARANCE_SETTINGS`) | Saved in Settings; every tab of the site follows                                                                                                                                                      |
| `setAppearance` without Settings                          | This page only                                                                                                                                                                                        |
| `preview(changes)`                                        | Applies without saving; the returned function ends it                                                                                                                                                 |
| `fontScale`                                               | Multiplies the font sizes (`font.size.*`); line heights are ratios and do not change                                                                                                                  |
| Reduced motion                                            | `motion.duration.*` become `0ms`                                                                                                                                                                      |
| The locale changes (Translation)                          | `dir` and `lang` on the root                                                                                                                                                                          |
| Each change                                               | Only the changed properties are written, in one frame. `design-system:theme-changed` (Page scope, LOW) carries the theme. The preferences go to `localStorage` (`platform:theme`) for the head script |
| A bad token name, an unknown token, a value out of range  | `RangeError`                                                                                                                                                                                          |
| No DOM (Node, a worker), or `root: null`                  | The theme is resolved; nothing is written                                                                                                                                                             |
| The subsystem stops                                       | The properties stay, so the page does not change                                                                                                                                                      |
| Sign-out (ARCHITECTURE §5.1)                              | Nothing to wipe: the preferences belong to the device                                                                                                                                                 |

## Options

| Option       | Default                    | Purpose                                                                                                         |
| ------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `tokens`     | `DEFAULT_TOKENS`           | The token set: `base`, and `modes` (`dark`, `contrast`, `darkContrast`, `density.compact`, `density.spacious`). |
| `root`       | `document.documentElement` | The element that gets the theme. `null` writes nothing.                                                         |
| `matchMedia` | `matchMedia`               | The media queries (tests).                                                                                      |
| `storage`    | `localStorage`             | Where the preferences are kept for the head script. `null` keeps nothing.                                       |
| `schedule`   | `requestAnimationFrame`    | When a write runs (tests).                                                                                      |

## Testing

```bash
pnpm exec vitest run --project node packages/design-system
BROWSERS=chrome,webkit pnpm exec vitest run --project browser packages/design-system
```

The browser test reads the computed style of real elements, and checks the stylesheet export alone.
