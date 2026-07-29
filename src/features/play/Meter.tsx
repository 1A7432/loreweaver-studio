export type MeterTone = "accent" | "hp" | "mp" | "san" | "context"

/** A thin labeled bar; `min` shifts the fill origin for ranged trackers. */
export default function Meter({
  label,
  value,
  max,
  min = 0,
  tone = "accent",
}: {
  label: string
  value: number
  max: number
  min?: number
  tone?: MeterTone
}) {
  const span = max - min
  const ratio = span > 0 ? Math.max(0, Math.min(1, (value - min) / span)) : 0
  return (
    <div className={`meter meter-${tone}`}>
      <span className="meter-label">{label}</span>
      <span className="meter-track" role="presentation">
        <span className="meter-fill" style={{ width: `${ratio * 100}%` }} />
      </span>
      <span className="meter-value">
        {value}/{max}
      </span>
    </div>
  )
}
