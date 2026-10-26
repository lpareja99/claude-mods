# image-view-transcript

A Claude Code mod for pasted images. It does three things:

- **Thumbnails above the prompt** as soon as you paste, instead of a bare `[Image #1]` tag.
- **Thumbnails on the sent message** in the transcript, which stay after the row above the prompt clears on send.
- **No duplicate pastes**: pasting the same picture twice in one prompt keeps only the first tag and shows a toast.

Real pictures in Ghostty and kitty; colored half blocks in other terminals. Non-PNG pastes are converted with `sips` (macOS).

## Install

```
/plugin install image-view-transcript --marketplace lpareja99/claude-mods
/reload-plugins
```

## Credits

The prompt thumbnails, PNG decoding and layout code are adapted from [jarrodwatts/claude-image-view](https://github.com/jarrodwatts/claude-image-view) (MIT, see [LICENSE](./LICENSE)).
