# Design system: Tokens

Part of the [design system](../design-system.md).

One TypeScript source, `packages/ui-tokens/src/index.ts`, generates
`tokens.css`; `packages/ui-web/src/styles.css` maps it into Tailwind's
`@theme inline`; mobile reads the same objects through
`apps/mobile/lib/appearance`. Run
`pnpm --filter @tangow/ui-tokens generate` after any change to the source.

## Colour

Every colour slot is opaque. The design expresses its greys as veils of ink or
white; they are flattened because opacity modifiers, `color-mix` and native
stacked fills all treat these as full colours. An `rgba` in a slot is a bug:
translucency lives only in the material layer (see [Material](materials.md#material)), never in a slot.
The dark planes rise in steps, each distinct from the one below on the ambient
light: `background`, `chatBot`, `surface`, `secondary`. A panel rises the same
way: `sheet`, then its `group`s.

| Slot | Light | Dark | Role |
| --- | --- | --- | --- |
| `background` | `#F2F2F4` | `#161618` | the page, under the ambient light |
| `foreground` | `#1D1D1F` | `#F5F5F7` | ink: text, primary, chrome icons |
| `foregroundSubtle` | `#86868B` | `#7C7C81` | passive grey: sidebar second line, placeholders (≈ 3.3:1) |
| `card`, `popover` | `#FFFFFF` | `#2C2C2E` | the opaque fallback of a glass control or menu |
| `cardForeground`, `popoverForeground` | `#1D1D1F` | `#F5F5F7` | |
| `primary` | `#1D1D1F` | `#F5F5F7` | primary capsule, Send |
| `primaryForeground` | `#FFFFFF` | `#1D1D1F` | |
| `secondary` | `#E8E8EA` | `#56565A` | secondary capsule, Stop |
| `secondaryForeground` | `#1D1D1F` | `#F5F5F7` | |
| `chatBot` | `#FFFFFF` | `#2C2C2F` | the bot's paper: every bot bubble, and everything the bot produces |
| `chatUser` | `#1D1D1F` | `#636366` | user bubble and avatar: ink in light, a clear step above the bot's paper in dark |
| `chatUserForeground` | `#FFFFFF` | `#F5F5F7` | |
| `mentionChip` | `#EDEDF0` | `#3A3A3D` | a mention token selected in the composer |
| `mentionChipForeground` | `#1D1D1F` | `#F5F5F7` | |
| `linkMentionTile` | `#F2F2F4` | `#444447` | the tile behind a link mention's icon in a bot bubble, a step off `chatBot` |
| `muted` | `#E8E8EA` | `#2A2A2D` | segmented track |
| `mutedForeground` | `#6E6E73` | `#AEAEB2` | clickable grey: meta, times, section labels, icons |
| `accent` | `#EBEBED` | `#252527` | icon-button hover |
| `accentForeground` | `#1D1D1F` | `#F5F5F7` | |
| `border`, `sidebarBorder` | `#E3E3E6` | `#2D2D30` | hairline of blocks and groups |
| `outline` | `#D2D2D6` | `#3F3F42` | the outlined task card's edge, stronger than `border` |
| `input` | `#D8D8DC` | `#4A4A4D` | field edge, switch track; reads on `group` and `sheet` in dark |
| `ring` | `#6E6E73` | `#AEAEB2` | focus |
| `surface` | `#FFFFFF` | `#3C3C3F` | the one elevation: the decision card |
| `sheet` | `#F5F5F7` | `#232326` | the opaque plane of the side panel and the overlay windows |
| `group` | `#FFFFFF` | `#333336` | a settings group or an activity day on a sheet |
| `well` | `#EEEEF1` | `#4E4E50` | reading matter and fields inside a decision card; a file's or the computer's icon tile |
| `sidebar` | `#F5F5F7` | `#2C2C2E` | the opaque fallback of the sidebar's glass |
| `sidebarForeground` | `#1D1D1F` | `#F5F5F7` | |
| `sidebarAccent` | `#E6E6E9` | `#414143` | selected and hovered row |
| `sidebarAccentForeground` | `#1D1D1F` | `#F5F5F7` | |
| `destructive` | `#DC2626` | `#EF4444` | failures only |
| `destructiveForeground` | `#FFFFFF` | `#FFFFFF` | |
| `success` | `#228B3B` | `#4ECB71` | |
| `warning` | `#B7791F` | `#E9C46A` | |
| `overlay` | `rgba(20, 20, 22, 0.45)` | `rgba(4, 4, 5, 0.72)` | |
| `scrollbar` | `#C7C7CC` | `#3A3A3D` | |
| `scrollbarHover` | `#AEAEB2` | `#4A4A4D` | |
| `optionRing` | `#DADADD` | `#636366` | the ring of an answer at rest: option tile, quick reply |
| `optionRingHover` | `#C7C7CC` | `#77777B` | option tile under the pointer, open answer field |
| `pressed` | `#E8E8EA` (`secondary`) | `#4A4A4D` | a control being pressed; 40% under the pointer |
| `mediaBackdrop` | `#000000` | `#000000` | the black behind a picture shown on its own, in both themes |
| `mediaBackdropForeground` | `#F5F5F7` | `#F5F5F7` | text and icons on `mediaBackdrop` |
| `mediaBackdropMuted` | `#AEAEB2` | `#AEAEB2` | secondary text on `mediaBackdrop` |
| `mediaBackdropControl` | `#2C2C2E` | `#2C2C2E` | a round control, or a picture's placeholder, on `mediaBackdrop` |
| `plate` | `#DCD8D9` | `#DCD8D9` | the clay plate behind an onboarding scene until its picture arrives; the scene dims to `sceneBrightness` 0.9 in dark |

`botColors` is user data and never changes with the skin. `botAccentOn`
judges a bot colour against `card`, the composer's opaque plane, where the
Stop contour is drawn.

Status starts in ink. A success check is grey
(`mutedForeground`), since a green check next to a green bot reads as the bot.
The one exception is a sent outbound draft: its confirmation is a 28 px
(32 pt on iPhone) `success` disc with a `primaryForeground` check, the leading element of its
settled card, because the message left the product and that is the one result
the person must not miss.
`destructive` marks a failure, and the controls that end or delete something
(End call, a delete in a menu), and nothing else. "Needs you" carries the
decision card's ink dot, never an amber pill.

## Typography

Utilities: `text-body`, `text-author`, `text-time`, `text-meta`, `text-label`,
`text-row-name`, `text-row-status`, `text-title`, `text-capsule`,
`text-working`, `text-reasoning`, `text-block-header`, `text-question`,
`text-mono`, `text-composer`. Each carries its own line height, tracking and weight.

Sizes are whole pixels on whole-pixel lines: `leading` is the line height
over the size, so `size × leading` is always an integer.

| Key | Size | Line | Tracking | Weight | Use |
| --- | --- | --- | --- | --- | --- |
| `body` | 16 | 24 | -0.01em | 400 | message prose (iPhone 17 / 22) |
| `author` | 13 | 18 | 0 | 500 | bot name above a message |
| `time` | 12 | 16 | 0 | 400 | time beside the name |
| `meta` | 13 | 18 | 0 | 400 | proof line under a message |
| `label` | 12 | 16 | 0 | 600 | sidebar section labels, day markers |
| `rowName` | 14 | 20 | -0.006em | 400 | sidebar row name (500 selected, mobile inbox 18 / 500, 600 unread) |
| `rowStatus` | 13 | 18 | 0 | 400 | sidebar status line (mobile inbox 15) |
| `title` | 15 | 20 | -0.01em | 600 | thread title (iPhone 17 / 22, 600) |
| `capsule` | 14 | 14 | 0 | 500 | capsule labels |
| `working` | 15 | 20 | -0.01em | 400 | "… is drafting the recap" |
| `reasoning` | 13 | 18 | 0 | 400 | reasoning summary and steps |
| `blockHeader` | 12 | 16 | 0 | 600 | framed-block header |
| `question` | 17 | 22 | -0.02em | 600 | the card title: a framed block's question |
| `mono` | 13 | 18 | 0 | 400 | durations and figures |
| `composer` | 17 | 22 | -0.01em | 400 | the mobile composer field (the native iOS body) |
| `largeTitle` | 34 | 37 | -0.025em | 650 | an onboarding step's title |
| `largeTitleCompact` | 30 | 33 | -0.025em | 650 | the same at phone width |
| `link` | 15 | 20 | 0 | 400 | a link standing alone under an onboarding step's main button |

The tokens spend a short set of roles. A new text style picks one of them.

| Role | Desktop | iPhone |
| --- | --- | --- |
| Caption | 12 / 16, 600 | 12 / 16, 600 |
| Footnote | 13 / 18 | 13 / 18 |
| Small body | 14 / 20 | — |
| Subhead | — | 15 / 20 |
| Body | 16 / 24 | 17 / 22 |
| Headline | 15 / 20, 600 | 17 / 22, 600 |
| Card title | 17 / 22, 600 | 17 / 22, 600 |
| Title | 22 / 28, 700 | 22 / 28, 700 |
| Hero | — | 24 / 30, 700 |

Don't: a half-point size or a fractional line height.

Fonts: one family for the bot and the person, the system's own.
`--font-sans` is `-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI",
Roboto, "Helvetica Neue", sans-serif`; `--font-mono` is `ui-monospace,
SFMono-Regular, Menlo, Consolas, monospace`. Nothing is bundled. Don't: a serif,
or a second family for either speaker. `font-mono` pairs with `tabular-nums`
wherever a number ticks.

## Space

Layout, in px: `sidebar 280`, `thread 800`, `header 56`, `panel 384`,
`panelWide 640`, `block 520` — `w-sidebar`, `max-w-thread`, `h-header`,
`w-panel`, `w-panel-wide` (the bot page while it edits a long text or a routine;
`pe-panel-wide` on the thread beside it), `max-w-block` (a framed block standing
alone in the thread, §3.3); `composerField 220` —
`max-h-composer-field`, the web/desktop composer field before it scrolls
internally. Gaps use the native Tailwind scale, which accepts any
multiple of 0.25 rem: `gap-3` is 12, `gap-5` is 20, `gap-7` is 28. Never
`gap-[…]`. Spacing sits on a 4 px grid; a hairline sits on a whole pixel.

## Radii

| Key | px | Utility | Use |
| --- | --- | --- | --- |
| `chip` | 6 | `rounded-chip` | section tags, draft highlights |
| `row` | 8 | `rounded-row` | sidebar rows, menu rows, buttons |
| `card` | 14 | `rounded-card` | option tiles, wells, fields in a card, menus |
| `draft` | 16 | — | shared draft (wave 2) |
| `block` | 24 | `rounded-block` | the decision card |
| `mobileBlock` | 28 | — | the decision card on iPhone |
| `bubble` | 20 | `rounded-bubble` | every message bubble, bot and user, and everything on the bot's paper |
| `linkMention` | 4 | — | a link mention's icon frame (`--corner-link-mention`) |
| `composer` | 24 | `rounded-composer` | the composer |
| `pane` | 18 | `rounded-pane` | the floating sidebar and side panel |
| `scene` | 28 | — | the onboarding scene card (`block` at phone width) |
| `mobileGroup` | 22 | — | a settings group on iPhone |
| `pill` | 9999 | `rounded-full` | capsules, round buttons, avatars |

A radius nested inside another is concentric: inner = outer − inset, when the
inset is 10 or less. That gives rows 8, menus 14, the palette 20 (its rows 14),
bubbles and the bot's paper 20, the decision card 24 (28 on iPhone), and the
floating sidebar and side panel 18. An overlay window is 24 and its inset
navigation panel 16 (24 − 8). Media inside a panel is 12. Settings groups are
16 on web and 22 on iPhone.

## Elevation

| Key | Light | Dark | Use |
| --- | --- | --- | --- |
| `row` | `none` | `none` | selected sidebar row: a fill, no shadow |
| `bubble` | `0 0 0 1px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.05)` | `inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 0 0 1px rgba(255, 255, 255, 0.05)` | a bot bubble and everything on the bot's paper: an edge, no lift |
| `card` | `0 0 0 1px rgba(0, 0, 0, 0.06), 0 2px 6px rgba(0, 0, 0, 0.05), 0 14px 32px -12px rgba(0, 0, 0, 0.18)` | `0 0 0 1px rgba(255, 255, 255, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 16px 40px -12px rgba(0, 0, 0, 0.7)` | the decision card, the thread's one elevation |
| `composerRest` | `0 0 0 1px rgba(17, 17, 20, 0.09)` | `0 0 0 1px rgba(255, 255, 255, 0.08)` | the composer at rest: a hairline only |
| `composerFocus` | `0 0 0 1px rgba(17, 17, 20, 0.09), 0 12px 28px -18px rgba(17, 17, 20, 0.55)` | `0 0 0 1px rgba(255, 255, 255, 0.16), 0 12px 28px -18px rgba(0, 0, 0, 0.8)` | the composer while its field has focus (dark also brightens the hairline) |
| `floating` | `0 1px 2px rgba(17, 17, 20, 0.08), 0 8px 20px -10px rgba(17, 17, 20, 0.35)` | `0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 20px -10px rgba(0, 0, 0, 0.7)` | the hover pill |
| `settled` | `0 0 0 1px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.05)` | `inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 0 0 1px rgba(255, 255, 255, 0.05)` | an answered framed block: back on the bot's paper, the `bubble` edge |
| `sheet` | `0 0 0 1px rgba(0, 0, 0, 0.07), 0 2px 8px -2px rgba(0, 0, 0, 0.08), 0 24px 48px -24px rgba(0, 0, 0, 0.22)` | `0 0 0 1px rgba(255, 255, 255, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 24px 48px -20px rgba(0, 0, 0, 0.7)` | the side panel, an overlay window |
| `group` | `0 0 0 1px rgba(0, 0, 0, 0.05)` | `0 0 0 1px rgba(255, 255, 255, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.04)` | a group's hairline |

Utilities `shadow-row`, `shadow-bubble`, `shadow-card`, `shadow-composer-rest`,
`shadow-composer-focus`, `shadow-floating`, `shadow-settled`, `shadow-sheet`,
`shadow-group`.
Everything the bot produces has **no** lift: `bg-chat-bot` and `shadow-bubble`,
like its bubble. Glass carries its own hairline and inner highlight, which do
not count as an elevation.

## Motion

| Key | Value | Use |
| --- | --- | --- |
| `ease` | `cubic-bezier(0.32, 0.72, 0, 1)` | every transition (`ease-quiet`) |
| `arrive` | 240 ms, `translateY(6px)` → 0, 0 → 1 opacity | a message, block or capsule arriving (`animate-arrive`) |
| `press` | 160 ms, `scale(0.96)` capsules (`rk-press`), `scale(0.94)` round controls (`rk-press-round`), `scale(0.985)` option tiles (`rk-press-tile`) | pressing |
| `hover` | 160 ms | colour and fill on hover (`duration-(--duration-hover)`) |
| `caret` | 1 s step-end | the typing caret |
| `pivot` | 320 ms, rotate -90° → 0 with scale and fade | the send arrow arriving with the first character |
| `morph` | 260 ms, rotate 45° | the mobile + turning into × while its sheet is open |
| `flow` | 2.6 s per lap | the Stop contour while a reply streams (static under reduced motion) |
| `fill` | 80 ms | a chosen answer taking the user's bubble colour before it leaves (`duration-(--duration-fill)`) |
| `spring` | response 320 ms, bounce 0.1 | the one spring of a question card's movement, as the CSS easing `springEasing` (a sampled `linear()`) or `springAt(ms)` for a scroll that follows it |
| `flight` | 520 ms | how long that spring runs: the answer flying into its bubble while the card folds, a stack's height, the list scrolling a card's foot into view |
| `stepOut` | 100 ms | a stack's old question fading out over the next one |
| `stepIn` | 160 ms, from the same frame | the next question fading in; a newly folded line waits `stepOut` first, so its answer never shows twice |
| `label` | 150 ms | a floating label rising out of its field (cut under reduced motion) |

## Sizes

Avatars: `receipt 14`, `stackXs 16`, `interstitial 17`, `chip 18`, `stack 20`,
`message 32`, `row 28`, `call 120`. Controls: `hoverIcon 28`, `quickReply 32`,
`composerIcon 34`, `capsule 36`, `mobileStack 44`, `callButton 52`. Mobile composer:
`composerAttach 48` (the detached + bubble), `composerTarget 44` (a button's
touch target in the capsule), `composerAction 36` (the send / stop disc).
Composer attachments (both devices): `composerAttachmentThumb 64` (the image
thumbnail / file-tile height), `composerAttachmentTile 200` (max width of a
file tile before its name truncates), `composerRemove 22` (the × disc).
Question card: `selectedRing 1.5` (the ring of a chosen option or of an answer
field being typed in).
Link preview card: `linkLargeImageRatio` 1.91 (the large format's picture, width over
height) and `linkCard 360` (its width on web, capped by the column),
`linkThumb 56` (the compact format's thumbnail), `linkIconInset 8` (the space around
a site icon inside that thumbnail, web and iOS), `linkPhotoMax 320` (the photo
format's maximum height). Link mention: `linkMentionIcon 16` (the site icon in the
text, web and iOS) and `linkMentionGap 5` (between that icon and the label). Entity
mention: `mentionGlyph 16` (a bot, group, everyone or skill glyph in the text, web and iOS)
and `mentionGap 4` (between that glyph and the name).
Onboarding: `field 56` and `fieldShort 52` (a floating-label field, and on a phone
under 760 px tall), `primaryButton 52` (the full-width main button), `logo 30` with
`logoTop 18` and `logoBottom 12` (its clear space at phone width: at least the
wordmark's x-height, 0.46 × its height, the screen's rounded corners included).

The sizes a primitive needs as a class are mapped into Tailwind's spacing
namespace in `packages/ui-web/src/styles.css` — `--spacing-hover-icon`,
`--spacing-quick-reply`, `--spacing-composer-icon`, `--spacing-capsule`,
`--spacing-mobile-stack`, `--spacing-call-button`, `--spacing-message`,
`--spacing-composer-attachment-thumb`, `--spacing-composer-attachment-tile`,
`--spacing-composer-remove`, `--spacing-link-card`, `--spacing-link-thumb`,
`--spacing-link-icon-inset`, `--spacing-link-photo-max` — so `size-composer-icon`, `h-capsule` and
`w-message` resolve to the token instead of an arbitrary value. `selectedRing`
is mapped to `--ring-width-selected`, so `ring-selected` draws it. The rest are
spent through a `size` prop.

## Geometry

Control heights, in px:

| Control | Desktop | iPhone |
| --- | --- | --- |
| In-row control | 24 | — |
| Pill | 32 | — |
| Card action | 36 | — |
| Glass capsule | 36, holding 32 px buttons with 2 px padding | — |
| Form field, primary button | 44 | — |
| Navigation button | — | 44 |
| Composer | 48 | 48 |
| Stacked actions | — | 48 |
| List row | — | ≥ 56 |

Icons, in px:

| Where | Size |
| --- | --- |
| In a line of text | 14 |
| Desktop chrome | 16 |
| In a control up to 40 | 18 |
| In a control of 44 to 56 | 20 |

One rendered stroke is ≈ 1.33 px up to 16, 1.5 px above.

Insets:

- Content text sits 16 from any surface edge.
- A group header aligns with its rows' text; a separator starts at the text.
- Floating controls share one side inset per platform, 12 on web and 16 on
  iPhone, and one header centreline.
