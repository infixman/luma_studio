import { useEffect, useRef } from 'preact/hooks'

const COLORS = ['#c9956b', '#e9c9a8', '#8b6e4e', '#d4a574', '#a67c52', '#f0d9b5', '#b3261e', '#2f6b46']
const COUNT = 80
const GRAVITY = 0.12
const DRAG = 0.98
const DURATION = 3500

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  w: number
  h: number
  color: string
  rotation: number
  spin: number
  opacity: number
}

function spawn(width: number, height: number): Particle {
  const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.2
  const speed = 6 + Math.random() * 8
  return {
    x: width * (0.3 + Math.random() * 0.4),
    y: height * 0.45,
    vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 4,
    vy: Math.sin(angle) * speed - Math.random() * 3,
    w: 4 + Math.random() * 6,
    h: 6 + Math.random() * 10,
    color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    rotation: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 0.3,
    opacity: 1,
  }
}

export function Confetti({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (!active) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)

    const particles: Particle[] = []
    for (let i = 0; i < COUNT; i++) {
      const p = spawn(rect.width, rect.height)
      p.vy -= i * 0.05
      particles.push(p)
    }

    const start = performance.now()
    let frame: number

    function draw(now: number) {
      const elapsed = now - start
      const fade = elapsed > DURATION - 800 ? Math.max(0, (DURATION - elapsed) / 800) : 1

      ctx!.clearRect(0, 0, rect.width, rect.height)

      for (const p of particles) {
        p.vy += GRAVITY
        p.vx *= DRAG
        p.vy *= DRAG
        p.x += p.vx
        p.y += p.vy
        p.rotation += p.spin
        p.opacity = fade

        ctx!.save()
        ctx!.translate(p.x, p.y)
        ctx!.rotate(p.rotation)
        ctx!.globalAlpha = p.opacity
        ctx!.fillStyle = p.color
        ctx!.fillRect(-p.w / 2, -p.h / 2, p.w, p.h)
        ctx!.restore()
      }

      if (elapsed < DURATION) {
        frame = requestAnimationFrame(draw)
      }
    }

    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [active])

  if (!active) return null

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    />
  )
}
