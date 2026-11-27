# Open asks of the engine

What the authoring studio needs, or tripped over, in the engine's 3.0 command line and formats.
Every 2.x-era item that used to be here was settled upstream or no longer applies to 3.0; they
are in git history.

1. **One stream for a command's answer.** `loreweaver pack` / `install` print their JSON object
   on stdout when they succeed and on stderr when they refuse (`server/src/cli/main.ts`:
   `(code === 0 ? console.log : console.error)(out)`). A tool has to read both and pick the last
   JSON line of stderr. Printing the object on stdout always (the exit code already says which)
   would remove the guesswork.
2. **`--version` is the one command that does not answer in JSON**, and it names the server
   version only. A tool comparing a pack's `engine.protocol` with what the engine speaks has no
   way to ask for the protocol version. `{"ok":true,"version":"3.0.0","protocol":"3.0"}` would do.
3. **The builder is silent about source files the manifest does not name.** It reads only named
   files, so a page's stray `ui/app.js` or an unreferenced picture simply is not in the archive,
   and nothing says so (`ignored` reports a skill's `hooks.js` only). Studio flags such files
   itself; listing them in the build's `ignored` would let every author see it.
4. **Two shapes of `ignored`.** The build JSON's top-level `ignored` is a list of paths; the trust
   card's `ignored` is a list of `{path, reason}`. One shape would be simpler to show.
5. **The panels reader is not shared.** Clients share `instantiate` / `panelBlocks` from the
   protocol package, but an authoring tool has to re-implement the panels file's checks
   (`server/src/core/panels/format.ts`) — Studio mirrors them in
   `src/features/studio/pack/panelsCheck.ts`, and the round-trip gate compares the two. Exporting
   the pure reader (and a parse-only condition compiler that returns references; the package
   exports only `evaluate`) from the protocol package would leave one implementation.
6. **Card-kind detection is not shared either.** A pack is refused when a card's declared kind
   disagrees with `splitCard` (`card_kind_mismatch`), so an authoring tool must predict that
   detection exactly. Studio's mirror (`split/cardSplit.ts`) counts EJS spans in the prose fields
   and entry contents; the engine also counts them in the name, tags, alternate greetings and
   entry titles and keys. A shared, pure `splitCard` would close the gap.
7. **No offline list of command ids.** A panel's choice names a command id. The only list Studio
   has is the engine's `commands` view fixture (eight commands), not the engine's full set
   (`pack`, `skill`, `panels`, `rule`, `rules.*`, …). A static export of the engine's command ids
   (and their parameter schemas) would let an editor offer them all.
8. **Byte vs character caps.** `parseManifest` compares `charCount(text)` with
   `MAX_MANIFEST_BYTES`, while `parsePanels` and `readPack` compare bytes — a CJK-heavy manifest
   between 256 Ki characters and 256 KiB passes one check and fails the other.
9. **Pregens.** The lorecard reader still parses a `pregens` section and a world import reports it
   as unsupported. If 3.0 will not seat pregenerated characters, saying so in `cards.md` (and
   refusing or ignoring the section uniformly) would settle what authors should write. Studio
   stopped writing it.
