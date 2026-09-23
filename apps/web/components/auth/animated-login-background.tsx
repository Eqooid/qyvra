"use client"

import { useEffect, useRef } from "react"
import { usePathname } from "next/navigation"

type Particle = {
  x: number
  y: number
  vx: number
  vy: number
  radius: number
  phase: number
  pulse: boolean
}

const FRAME_INTERVAL = 1000 / 30

export function AnimatedLoginBackground() {
  const pathname = usePathname()
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (pathname !== "/login") return

    const container = containerRef.current
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!container || !canvas || !context) return

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)")
    let particles: Particle[] = []
    let width = 0
    let height = 0
    let frame = 0
    let lastFrame = 0
    let accent = ""

    function readAccent() {
      accent = getComputedStyle(document.documentElement)
        .getPropertyValue("--primary")
        .trim()
    }

    function draw(time: number, advance: boolean) {
      if (!context) return
      const dark = document.documentElement.classList.contains("dark")
      context.clearRect(0, 0, width, height)
      const distanceLimit = width < 600 ? 105 : 135
      const links = new Uint8Array(particles.length)

      for (let i = 0; i < particles.length; i++) {
        const a = particles[i]
        for (let j = i + 1; j < particles.length; j++) {
          if (links[i] >= 2 || links[j] >= 2) continue
          const b = particles[j]
          const distance = Math.hypot(a.x - b.x, a.y - b.y)
          if (distance >= distanceLimit) continue
          context.beginPath()
          context.moveTo(a.x, a.y)
          context.lineTo(b.x, b.y)
          context.strokeStyle = accent
          context.globalAlpha =
            (dark ? 0.31 : 0.27) * (1 - distance / distanceLimit)
          context.lineWidth = 1.3
          context.stroke()
          links[i]++
          links[j]++
        }
      }

      for (const particle of particles) {
        const pulse =
          particle.pulse && !motion.matches
            ? 1 + 0.13 * Math.sin(time * 0.0012 + particle.phase)
            : 1
        context.beginPath()
        context.arc(
          particle.x,
          particle.y,
          particle.radius * pulse,
          0,
          Math.PI * 2
        )
        context.fillStyle = accent
        context.globalAlpha = dark ? 0.72 : 0.65
        if (particle.pulse) {
          context.shadowColor = accent
          context.shadowBlur = dark ? 8 : 5
        }
        context.fill()
        context.shadowBlur = 0

        if (advance) {
          particle.x += particle.vx
          particle.y += particle.vy
          if (particle.x < 8 || particle.x > width - 8) particle.vx *= -1
          if (particle.y < 8 || particle.y > height - 8) particle.vy *= -1
        }
      }
      context.globalAlpha = 1
    }

    function tick(time: number) {
      frame = requestAnimationFrame(tick)
      if (time - lastFrame < FRAME_INTERVAL) return
      lastFrame = time
      draw(time, true)
    }

    function start() {
      cancelAnimationFrame(frame)
      frame = 0
      if (!document.hidden && !motion.matches) {
        lastFrame = 0
        frame = requestAnimationFrame(tick)
      } else {
        draw(performance.now(), false)
      }
    }

    function resize() {
      if (!container || !canvas || !context) return
      width = container.clientWidth
      height = container.clientHeight
      if (!width || !height) return
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      particles = Array.from(
        {
          length: Math.min(
            46,
            Math.max(12, Math.round((width * height) / 30000))
          ),
        },
        (_, index) => ({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.18,
          vy: (Math.random() - 0.5) * 0.18,
          radius: 1.5 + Math.random() * 0.9,
          phase: Math.random() * Math.PI * 2,
          pulse: index % 7 === 0,
        })
      )
      draw(performance.now(), false)
      start()
    }

    readAccent()
    const observer = new ResizeObserver(resize)
    const themeObserver = new MutationObserver(() => {
      readAccent()
      if (motion.matches) draw(performance.now(), false)
    })
    observer.observe(container)
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    motion.addEventListener("change", start)
    document.addEventListener("visibilitychange", start)
    window.addEventListener("resize", resize)
    resize()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      themeObserver.disconnect()
      motion.removeEventListener("change", start)
      document.removeEventListener("visibilitychange", start)
      window.removeEventListener("resize", resize)
    }
  }, [pathname])

  if (pathname !== "/login") return null

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="auth-network-background pointer-events-none absolute inset-0 z-0 overflow-hidden"
    >
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  )
}
