# Design system: Primitives

Part of the [design system](../design-system.md).

Every primitive lives in `packages/ui-web/src/<name>.tsx`, is exported from the
barrel, carries `data-slot="<name>"` on its root, merges a `className` through
`cn`, holds no copy (labels arrive as props or children, icon buttons take
`aria-label`), and has a `renderToString` test next to it. Each one also spreads
the remaining native props of its root element, so a screen can attach a
`data-testid`, an `id` or an `aria-*` without a wrapper.

The plain classes the primitives apply — `rk-press`, `rk-press-round`, `rk-press-tile`, `rk-bar`,
`rk-dot`, `rk-shimmer` — live in Tailwind's `components` layer, so a utility
passed through `className` always wins over them.

## Button — Quiet variants

`packages/ui-web/src/components/ui/button.tsx`. The stock shadcn variants are
untouched; the Quiet ones are added beside them. **Pair each variant with its
matching size** — the variant carries the fill and the horizontal padding, the
size carries the height or the square.

| Variant | Anatomy |
| --- | --- |
| `capsule` | `bg-primary`, `text-primary-foreground`, `text-capsule` at 500, `rounded-full`, hover to 85% opacity |
| `capsuleSecondary` | `bg-secondary` on ink text, otherwise the capsule |
| `tertiary` | transparent, `text-muted-foreground`, ink on hover |
| `quickReply` | transparent inside an `optionRing` ring, `bg-accent` on hover |
| `roundIcon` | transparent circle, `text-muted-foreground`, `bg-accent` on hover |
| `roundIconSecondary` | `bg-secondary` circle on ink, hover to 85% opacity; an add control that must read as one |

| Size | px | Utility |
| --- | --- | --- |
| `capsule` | 36 | `h-capsule` |
| `quickReply` | 32 | `h-quick-reply` |
| `roundIcon` | 34 | `size-composer-icon` |
| `roundIconSm` | 28 | `size-hover-icon` |
| `stack` | 44 | `h-mobile-stack` |
| `call` | 52 | `size-call-button` |
| `full` | 52, full width | `h-primary-button` (pair with the default variant: an onboarding step's main button) |

`consequential` prefixes a 13 px lock and sets `data-consequential="true"`, so
an action that cannot be taken back reads as one before it is pressed. The size
also decides the press: a capsule settles to 0.96, a round control to 0.94.
Every variant focuses on `ring`. An answer carries a ring (`quickReply`,
`OptionTile`); a command is filled (`capsule`, `capsuleSecondary`).

Do: `<Button variant="capsule" size="capsule">{t\`Allow once\`}</Button>`.
Don't: a Quiet variant with the default size, or a capsule whose label is
written inside the primitive.

Used by: the framed block's actions, quick replies, the composer, the hover
pill, the call view.

## OnboardingFrame and FloatingField

`packages/ui-web/src/onboarding-frame.tsx`, `floating-field.tsx`, laid out by
`onboarding.css`. One frame for every step before an account exists: the
wordmark, the clay scene card (`plate`, 10:9 at phone width, smaller but never
cropped tighter on a short screen) and a step box as tall as the tallest step,
with its actions anchored at the foot so the title and the main button land at
the same place on every step. Under 860 px wide the card sits above the box and
the actions sit under the thumb; while a phone keyboard is up only the main
button shows, just above it. Under 760 px tall the form tightens (`fieldShort`).
A step with no field, such as a sent link, says its sentence in a `p` under the
title (body size, `muted-foreground`).

The card shows the clay stop-motion (`PlateScene` on web). Its tables live once in
`@tangow/contracts` (`onboarding-plate.ts`) for every client: the still each step
rests on, and the frames played at 150 ms each when moving forward. Going back, a
reload or reduced motion shows the still alone. Once a still has loaded, the
frames toward the next steps decode in the background; a transition skips a frame
that has not, rather than wait for it.

`FloatingField` is a Base UI `Field`: its real `<label>` is the accessible name,
sits inside the empty field at 16 px and rises to 12 px on focus or once filled
(`label` duration). Its error sits in the gap under the field and pushes
nothing; `invalid` marks the value itself as wrong.

## FramedBlock

The only framed element of the thread: a decision or a question the bot cannot
settle alone.

Props: `header?: { who, dot?, icon?, status? }`, `question?` (left out only on
an answered block whose answer says it all on one line), `consequence?`,
`children?`, `actions?`, `actionsAlign?: "end" | "start"` (default `end`),
`answered?`.
Anatomy: `bg-surface rounded-block shadow-card` (radius 28 on iPhone),
padding 20; an optional header line with a 6 px ink dot, the `icon` of the app
the decision acts in, `who`, and a short `status` at the end, in
`text-block-header`; the question in `text-question`; the consequence in
`text-meta`; `children` for controls, with anything to read again or type in a
`well` (`rounded-card`); the actions wrapped in a row of filled capsules.
States: open (controls and actions) and **answered**. Setting `answered`
settles the block: the controls and the actions are dropped whether or not
they are still passed, one `text-meta` line takes their place, the root
carries `data-answered="true"` and the card drops onto the bot's paper
(`bg-chat-bot rounded-bubble shadow-settled`, 12 × 16 padding), giving the
thread back its one elevation. Nothing that cannot be pressed is left looking
pressable.

The card is the body of a normal bot message row, full width of the column
rather than capped like a bubble — the group's name and avatar already say who
is asking, so the card repeats that only for a
consequential approval, name-less ("Needs your call"); a plain question,
`ask_user` question, or `choice` passes no `header` at all and opens straight
on the question.

Alignment. On web and desktop the actions of a decision sit on the right
(`actionsAlign="end"`), ordered dismiss, then Edit or the secondary approval,
then the primary last: "Not now" or "Deny", "Edit", "Allow once". The
onboarding focus card follows the same rule: its "Dismiss" moves right while its
options stay left. A list of answers to a question (`ask_user`, `choice`, a
stepper's options) is content to read, not a validation: it stays in `children`
and left-aligned, and an action that only belongs to that list passes
`actionsAlign="start"`. iOS: full-width stacked 48 pt capsules, primary on
top.

Do: one open block per thread. Don't: frame an ordinary message, or put a
second shadow or a bordered card inside it.

Used by: approval asks, bot questions (`ask`, `ask_user`, `choice`) and secret
asks, each rendered as a normal bot row.

### Outbound draft card

A message the bot wrote in the person's name, in a `FramedBlock`. The header
holds the app's mark, from the bundled marks in `@tangow/core` (Gmail, Outlook,
Slack), else a neutral glyph in `mutedForeground`, never a letter; a catalog
`logo` wins over both. Open, it reads as a grid: a 64 px label column (72 pt on iPhone), then From
(avatar, name, account), To in 500, Cc, Bcc, Subject, all at `text-row-name`
(15 / 20 on iPhone), and the text in a `well`. Values start 16 px in, where a
field's text sits, so nothing moves sideways when editing starts. Touching a
field turns each editable line into a 44 px field on the `well`
(`rounded-card`, `text-body`, the body's hover and selected rings); a field of
chips pads 8 around them, so the chip's text still sits 16 in, and `px-4`
otherwise. Recipients become chips with their own 24 px remove button, and Cc
and Bcc are buttons at the end of the To field that open their own row. A line
already full has no field: the line itself takes focus and starts editing.
Labels stay outside the fields. The lines stay fields until the card is
answered, and keep their shape, read-only, while a send is on its way, so Send
never moves from under the pointer.

Sent, the card settles on the bot's paper (`FramedBlock` `answered`): the
success disc on the left spanning "Sent" (`text-title`) and "to …" (`text-meta`,
the address in ink), the time at the end of the "Sent" row (`text-time`), then
one line under the text column with the app's mark and the subject, or the
text's first line for chat. There is no Undo after Send. Discarded is one line:
the mark, "Discarded", and "· Undo" while the 5 s window is open.

## OptionTile

One answer of a question card (`ask_user`, a legacy choice): a full-width
`<button>` in `rounded-card`, `px-4 py-3`, at least 52 px (`min-h-13`), on a
1 px `optionRing` ring with no fill; under the pointer the ring takes
`optionRingHover` over `pressed` at 40%, and a press settles to 0.985
(`rk-press-tile`). The label is 15 / 20 at 500 (17 / 22 on iPhone), plain text
with `dir="auto"`, wrapping. Props: `selected?` (a `ring-selected` `foreground`
ring and a check, announced with `aria-pressed`), `filled?` (the answer on its way:
`chatUser` over `--duration-fill`), `trailing?` (replaces the check, such as
Other…'s pencil), `detail?` (a muted `text-meta` line under the label, announced
as the tile's description: what the option does, after a plain "Recommended ·"
on the one recommended option, which is never preselected, reordered or focused
first). Tiles stack 8 apart (`gap-2`) in a `<fieldset>` named by the
question.

`OptionField` is a typed answer in the same shape: a `<form>` on an
`optionRingHover` ring that turns `ring-selected` `foreground` while typing,
holding an `<input>` (its native props) and a primary `roundIconSm` send.
Props: `sendLabel`, `canSend`, `onSend`, `filled?` (as on a tile). Digit
shortcuts never reach it.

`StackLine` is an answered question of a stack, folded above the current one:
a `<button>` at least 44 px (`min-h-11`), `py-2.5`, bleeding 8 into the card's
inset (`-mx-2 px-2`) so its `rounded-row` hover fill (`pressed`) lines up with
the question. One `text-row-name` row: the `label` muted and truncated at half
the width, the `value` in `foreground` taking the rest, then a muted 14 px
chevron. Pressing it opens the question again. Props: `label`, `value`, and the
native button props.

A question card once answered or no longer waiting is not a `FramedBlock` but
`AskSettled`: one muted `text-meta` line (a check, or a stop and "No longer
active") inset by 16, then the answer in a `UserBubble` named "Your answer: …"
with no message actions.

## Surface

The bot's paper: everything the bot produces sits on the same plane as its
bubble, never lifted.

Props: `as?`. Renders `bg-chat-bot shadow-bubble rounded-bubble`, no border,
padding 16. An icon inside it (a file, the computer) sits in a `well`, without
colour.

`variant="outlined"` (mobile and web) trades the edge for a 1 pt `outline`
ring: the thread's only outlined card, for a sub-agent's task.

Do: tables, code blocks, link previews, files, charts, results, a new bot, the
computer. Don't: add `shadow-card` to make it stand out, since that shadow
belongs to `FramedBlock`.

Used by: markdown tables, code blocks, link previews, result cards;
outlined for a delegated task's result (subagent).

## LinkPreviewCard

What the article or photo behind a link looks like, kept with the message's attachments: under
the bubble (or alone, in the bubble's place, when the message is only its link),
`gap-1` below it and aligned to its edge. Three formats the server picks from what
it downloaded: `large` (picture at `linkLargeImageRatio`, 1.91:1, from `@tangow/ui-tokens` on both surfaces, then title and site), `compact`
(56 px thumbnail when there is a picture, title, site) and `photo` (the picture
alone in a `rounded-bubble` frame capped at `linkPhotoMax`, the site under it).
Only an article (a page whose head declares one) or a direct image link gets a card; a
document, a tool, a home page or a site that refuses the server's read shows as a
`LinkMention` in the text instead.
When the page has no usable picture, a compact card takes the site's icon as its
thumbnail (the server marks the image `fit: "contain"`; an icon is never a `large`
card): the icon is drawn whole and centered in the same 56 px `bg-secondary` tile,
inset by `p-link-icon-inset` (the `linkIconInset` token, 8 pt on iOS), never cropped. Pictures that are not icons keep
filling the tile and crop at the center.
A compact card with no picture at all keeps the tile and draws the site's initial in it
(`previewSiteInitial`, `text-title text-muted-foreground`, centered, decorative). When the
card shows the link, the bubble leaves out a line that is only that link
(`textWithoutPreviewedLinkLine`; a link inside a sentence stays; Copy, search and the model
keep the stored text).

Props: `href`, `site` (the host of `href`, derived by `previewSiteLabel`, never cut
from the end), `title?` (plain text, from `sanitizePreviewTitle`), `format`,
`image?` (a node filling its frame; `LinkPreviewPicture` draws it, `fit="contain"` for an icon), `imageRatio?` (a photo's width over height),
`onOpen?`. Anatomy: an `<a target="_blank" rel="noreferrer noopener">` named
"title, site" (a photo: the site) around a `Surface` of `w-link-card max-w-full`;
title `text-row-name` at weight 500 on two lines, `dir="auto"` inside a `<bdi>`;
site `text-meta text-muted-foreground`, wrapped rather than ellipsized; the
frame is `bg-secondary`, the picture decorative (`alt=""`). Arrival is
`animate-arrive`, the only motion.

The picture is never a remote URL: it is the preview's own artifact, loaded like an
attached image, with a `secondary` tile and the image glyph when it cannot be
read. The card draws nothing for a URL that is not http(s) and carries no control
of its own: "Remove preview" lives in the message's actions (hover pill, or Edit
and Copy under your own message).

Do: leave a message that has no preview exactly as it is, and add no copy. Don't:
add a lift (`shadow-card`) or a colour bar, a description of the page, a loading
or error word, or `variant="outlined"` (reserved for a bot's work product).

Used by: the web and desktop thread (`apps/web/src/pages/shell/message-view.tsx`).

## LinkMention

A link the server resolved, in place in the sentence: the site's icon, then a readable
label, in the bubble's ink with the bubble's link underline. No box and no fill: the icon
alone says the link goes somewhere. `packages/chat-ui/src/link-mention.web.tsx`, drawn by
`ChatMarkdown` for a bot and `LinkifiedText` for the person, both given the message's
resolver (`mentions`, memoized on the message's `link_mention` blocks in `message-view.tsx`,
so an equal re-projection does not re-parse the markdown). A link turns into a mention only when the message has a `link_mention` block
for it (`linkMentionsOf`, matched by `linkKey`); every other link renders as before.
The label is the author's markdown label when it says more than the address, else the
server's title, else the host (`linkMentionLabel`).

Anatomy: an `<a data-slot="link-mention" target="_blank" rel="noreferrer noopener">`,
`inline-flex`, exactly one line box tall and bottom-aligned, so its text keeps the
sentence's baseline and the icon sits centred on the line; `nowrap`, so the icon never ends
a line alone; at most `min(32ch, 100%)` wide. The icon frame is `linkMentionIcon` (16) at
`--corner-link-mention` (4) on a `linkMentionTile` tile with a 10% `foreground` hairline, so
a dark or transparent site icon still reads on the bubble; in the person's bubble the tile
is a 14% veil of its text colour and no hairline. `linkMentionGap` (5) before the label,
never underlined and `aria-hidden`. The label is inert text in a `<bdi>` and ends in an
ellipsis rather than widen the bubble. Name "label, host" (the host alone when it is the
label), the full URL as `title`, its host in punycode as the browser will open it.

States. The site icon comes from the thread's artifact like a card's picture
(`LinkMentionIcon`), never a remote URL; the frame shows only its tile while it loads and
the icon arrives without motion. With no icon, or one that cannot be read, `LinkMentionGlyph`
draws lucide's link glyph at 62.5% of the frame in `mutedForeground` on the same tile; in
the person's bubble the glyph takes its text colour. Before the server read the page, or
when the read failed, the link stays plain. Hover makes the underline solid. Focus is a
2 px outline at 2 px offset in `ring`; in the person's bubble its text colour at 60%, since
`ring` reaches only about 3:1 there.

Do: keep the mention a link in the sentence and let its label truncate. Don't: give it a
pill or a background (it would read as a composer mention chip), an initial in place of
the glyph, a loading state or a host beside the label.

iPhone (`packages/chat-ui/src/link-mention.native.tsx`, given the message's resolver by
`MessageBubble` and `RoutineBubble` in `apps/mobile/app/thread.tsx`, memoized the same way). The mention is a
`Text` nested in the sentence, never a `Pressable`, so the paragraph keeps one layout and one
selection. The icon frame is an inline view `linkMentionIcon + linkMentionGap` wide that
carries the gap, since nested text has no margins; iOS sets an inline view's bottom on the
line's descender, which centres the 16 pt frame on the bubble's 23 pt line with no offset. A
word joiner (U+2060) between the frame and the label keeps them on one line, and the label
(U+2068 … U+2069) wraps like the words around it, since nested text cannot ellipsize; the
server caps its title at 80 characters. The site icon (`components/link-mention-icon.tsx`)
reads the thread's artifact like a card's picture; the glyph is the `link` SF Symbol at 62.5%
of the frame. The hairline is drawn under the icon, as the web's inset shadow is, so an opaque
icon covers it. Tap opens the link; a long press stays the message's action sheet (a routine bubble has none, so a long press on its card does nothing). The label
takes the text style of the link's ancestors in the markdown, never its own runs, so a bold
sentence makes it bold and a code label stays a plain label; in the person's bubble it takes
the bubble's. VoiceOver reads the mention's label, without the host the web adds, since iOS
names a nested link by its text; the host shows when the link opens in the browser. Links
inside a table stay plain on iPhone, since `TableGrid` draws its own links.

Used by: the web and desktop thread, and the iPhone thread.

## EntityMention

A bot, group, `@everyone` or skill named in a message, in place in the sentence: a
`mentionGlyph` (16) glyph glued to the semibold name, `mentionGap` (4) between them, no `@`
or `/`. The glyph says what it is: a bot's clay face (the only colour), a circle on
`avatarDisc` for who can answer (group, everyone), a square on the `linkMentionTile` with a
10% `foreground` hairline for what gets used (skill, routine, connector); in the person's
bubble the tile is a 16% veil of its ink. No fill and no underline, so it never reads as a
link mention. `packages/chat-ui/src/entity-mention.web.tsx`, drawn by `LinkifiedText` and, for
a bot, `ChatMarkdown` (never inside code or a link), from the thread's catalog given once by
`EntityMentionsProvider` in `shell-main.tsx`: what the composer can name plus the skills.
Nothing is stored: the sent text keeps `@Name` and a leading `/skill` line, and
`messageSegments` (`@tangow/core`) matches them longest name first on word boundaries; a
name the client does not know stays text. Web anatomy is a link mention's: `inline-flex`,
one line box tall, `nowrap`, at most `min(22ch, 100%)` with the name ellipsized in a `<bdi>`.

In the web composer the textarea stays; `DraftMirror` (`composer-mirror.tsx`) draws the draft
over it with the textarea's own text transparent, so the caret and selection are native.
`EntityMentionField` keeps every character, so advance widths match: the glyph is drawn over
the `@`, as wide as it allows, or for a leading skill in a first-line indent of
`mentionGlyph` before its `/`; the weight is a stroke. Arrow keys step over a token, and
Backspace or Delete next to one selects it (a `mentionChip` fill) before removing it whole.
Editing a token's text drops the mention.

iPhone (`entity-mention.native.tsx`, `NativeEntityMentionsProvider` in `thread.tsx`): the
bubble draws the glyph as an inline view glued with a word joiner, as a link mention; the
composer's `TextInput` cannot hold a view, so a token is styled text in it, a muted `@` or
`/` and a semibold name.

## ComposerLinkPreview

What the first complete link of the draft will look like, in the composer's
`attachments` row beside `ComposerAttachment` (iOS: the same row, `components/
composer-link-preview.tsx`). Always the compact card whatever format the server
picked: `h-composer-attachment-thumb` (64) in `bg-background` at `rounded-card`,
a `size-link-thumb` thumbnail, the title on one line, the site under it. Nothing
shows while the page is read: the card appears only once it is ready, so a link
that is not an article never flashes one. The × is the shared
`ComposerRemoveButton` (`composerRemove`, `bg-primary`, `border-surface` ring,
named "Remove preview"; 44 pt target on iOS). The card is not a link and a failed
or empty read draws nothing and says nothing.

The picture is only the inline thumbnail `links.preview` returns, accepted by
`acceptPreviewThumbnail` (a `data:image/webp;base64,` URL of at most 70 000
characters) and never copied into a message. When to read, the 800 ms debounce, the
cancellation and the per-draft removal live once, in `createComposerLinkPreview`
(`@tangow/core`); a removed preview sends `linkPreview: false`.
