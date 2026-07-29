export function ColourPicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label class="ui-colour-picker">
      <span class="ui-label">{label}</span>
      <span class="ui-colour-picker-control">
        <input
          type="color"
          value={value}
          aria-label={`${label}調色盤`}
          onInput={(event) => onChange((event.currentTarget as HTMLInputElement).value)}
        />
        <span class="ui-colour-picker-copy">
          <strong>開啟調色盤</strong>
          <code>{value.toUpperCase()}</code>
        </span>
      </span>
    </label>
  )
}
