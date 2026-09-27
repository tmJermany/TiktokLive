/**
 * Canvas effects engine for the overlay.
 *
 *   engine.play('moneygun', { count })  -> money gun bursts + rain of bills
 *   engine.play('galaxy',   { count })  -> screen break, shatter, spiral galaxy
 *   engine.play('rose',     { count })  -> gentle falling roses and petals
 *
 * play() returns the effect duration in ms. The render loop only runs while
 * at least one effect is alive, so an idle overlay costs nothing.
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const rand = (min, max) => min + Math.random() * (max - min);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const easeInCubic = (t) => Math.pow(clamp(t, 0, 1), 3);

  function makeCanvas(width, height, scale) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    return { canvas, ctx, width, height };
  }

  // -------------------------------------------------------------------------
  // Sprites (pre-rendered once so each frame is just drawImage calls)
  // -------------------------------------------------------------------------

  function createBillSprite(scale) {
    const w = 120;
    const h = 56;
    const { canvas, ctx } = makeCanvas(w, h, scale);

    const body = ctx.createLinearGradient(0, 0, w, h);
    body.addColorStop(0, '#5fd38a');
    body.addColorStop(0.5, '#2f9e5b');
    body.addColorStop(1, '#1d7a44');
    ctx.fillStyle = body;
    roundRect(ctx, 1, 1, w - 2, h - 2, 5);
    ctx.fill();

    ctx.strokeStyle = 'rgba(220, 255, 225, 0.75)';
    ctx.lineWidth = 2;
    roundRect(ctx, 6, 6, w - 12, h - 12, 3);
    ctx.stroke();

    const seal = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, 17);
    seal.addColorStop(0, '#d7ffe2');
    seal.addColorStop(1, '#3fae6b');
    ctx.fillStyle = seal;
    ctx.beginPath();
    ctx.ellipse(w / 2, h / 2, 17, 17, 0, 0, TAU);
    ctx.fill();

    ctx.fillStyle = '#145c33';
    ctx.font = '700 22px "Segoe UI", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', w / 2, h / 2 + 1);

    ctx.fillStyle = 'rgba(235, 255, 240, 0.95)';
    ctx.font = '700 11px "Segoe UI", Helvetica, Arial, sans-serif';
    ctx.fillText('100', 20, 16);
    ctx.fillText('100', w - 20, h - 15);

    return { canvas, width: w, height: h };
  }

  function createCoinSprite(scale) {
    const size = 40;
    const { canvas, ctx } = makeCanvas(size, size, scale);
    const r = size / 2 - 1;
    const g = ctx.createRadialGradient(size * 0.35, size * 0.32, 2, size / 2, size / 2, r);
    g.addColorStop(0, '#fff6c4');
    g.addColorStop(0.45, '#ffd34d');
    g.addColorStop(1, '#c98a06');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(150, 95, 0, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, r - 4, 0, TAU);
    ctx.stroke();
    ctx.fillStyle = '#9a6400';
    ctx.font = '800 18px "Segoe UI", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', size / 2, size / 2 + 1);
    return { canvas, width: size, height: size };
  }

  function createRoseSprite(scale) {
    const w = 60;
    const h = 90;
    const { canvas, ctx } = makeCanvas(w, h, scale);
    const cx = w / 2;
    const cy = 26;

    // Stem and leaves.
    ctx.strokeStyle = '#2f7d32';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy + 14);
    ctx.quadraticCurveTo(cx + 5, cy + 40, cx - 2, h - 4);
    ctx.stroke();
    ctx.fillStyle = '#3d9a40';
    leaf(ctx, cx + 2, cy + 38, 14, 6, -0.6);
    leaf(ctx, cx - 1, cy + 50, 12, 5, 3.6);

    // Outer petals.
    const petalColors = ['#8e0f24', '#b3152f', '#d6243f'];
    for (let ring = 0; ring < 3; ring++) {
      const count = 5 - ring;
      const radius = 17 - ring * 5;
      ctx.fillStyle = petalColors[ring];
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU + ring * 0.6;
        ctx.beginPath();
        ctx.ellipse(
          cx + Math.cos(a) * radius * 0.35,
          cy + Math.sin(a) * radius * 0.3,
          radius * 0.7,
          radius * 0.55,
          a,
          0,
          TAU
        );
        ctx.fill();
      }
    }

    // Swirled centre + highlight.
    ctx.strokeStyle = 'rgba(90, 0, 15, 0.7)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    for (let t = 0; t < 10; t += 0.25) {
      const r = t * 0.55;
      const x = cx + Math.cos(t) * r;
      const y = cy + Math.sin(t) * r * 0.8;
      if (t === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const shine = ctx.createRadialGradient(cx - 5, cy - 7, 1, cx - 5, cy - 7, 12);
    shine.addColorStop(0, 'rgba(255, 190, 200, 0.55)');
    shine.addColorStop(1, 'rgba(255, 190, 200, 0)');
    ctx.fillStyle = shine;
    ctx.beginPath();
    ctx.arc(cx - 5, cy - 7, 12, 0, TAU);
    ctx.fill();

    return { canvas, width: w, height: h };
  }

  function createPetalSprite(scale) {
    const w = 22;
    const h = 16;
    const { canvas, ctx } = makeCanvas(w, h, scale);
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#ff5a74');
    g.addColorStop(1, '#a80f2a');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(1, h / 2);
    ctx.bezierCurveTo(w * 0.3, -2, w * 0.9, 0, w - 1, h / 2);
    ctx.bezierCurveTo(w * 0.9, h, w * 0.3, h + 2, 1, h / 2);
    ctx.fill();
    return { canvas, width: w, height: h };
  }

  function createGlowSprite(scale, color) {
    const size = 64;
    const { canvas, ctx } = makeCanvas(size, size, scale);
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return { canvas, width: size, height: size };
  }

  /** Horizontally mirrored copy, drawn when a tumbling sprite shows its back. */
  function mirrorSprite(sprite) {
    const canvas = document.createElement('canvas');
    canvas.width = sprite.canvas.width;
    canvas.height = sprite.canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(sprite.canvas, 0, 0);
    return { canvas, width: sprite.width, height: sprite.height };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function leaf(ctx, x, y, length, width, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(length / 2, -width, length, 0);
    ctx.quadraticCurveTo(length / 2, width, 0, 0);
    ctx.fill();
    ctx.restore();
  }

  function drawSprite(ctx, sprite, x, y, size, rotation, flipX, alpha) {
    const ratio = sprite.height / sprite.width;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(flipX, 1);
    ctx.drawImage(sprite.canvas, -size / 2, (-size * ratio) / 2, size, size * ratio);
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Money Gun: bursts fired from the bottom corners, then a rain of bills
  // -------------------------------------------------------------------------

  class MoneyRainEffect {
    constructor(engine, { count = 1 }) {
      this.engine = engine;
      this.time = 0;
      this.duration = clamp(6.5 + (count - 1) * 1.2, 6.5, 10);
      this.burstUntil = 1.6 + Math.min(count - 1, 3) * 0.5;
      this.rainUntil = this.duration - 2.2;
      this.nextBurst = 0;
      this.rainAccumulator = 0;
      this.particles = [];
      this.maxParticles = 420;
      this.done = false;
    }

    get billSize() {
      return clamp(this.engine.width / 7.5, 40, 86);
    }

    spawnBill(x, y, vx, vy, fromGun) {
      if (this.particles.length >= this.maxParticles) return;
      const isCoin = Math.random() < 0.16;
      this.particles.push({
        x,
        y,
        vx,
        vy,
        rotation: rand(0, TAU),
        spin: rand(-3, 3),
        flip: rand(0, TAU),
        flipSpeed: rand(3, 8),
        sway: rand(0.8, 2.2),
        swayPhase: rand(0, TAU),
        size: (isCoin ? 0.38 : 1) * this.billSize * rand(0.75, 1.15),
        sprite: isCoin ? 'coin' : 'bill',
        fromGun
      });
    }

    fireBurst() {
      const { width, height } = this.engine;
      for (const side of [-1, 1]) {
        const originX = side < 0 ? width * 0.08 : width * 0.92;
        const originY = height + 10;
        const shots = Math.round(rand(9, 14));
        for (let i = 0; i < shots; i++) {
          const angle = -Math.PI / 2 + side * -rand(0.15, 0.65);
          const speed = rand(0.9, 1.35) * height;
          this.spawnBill(originX, originY, Math.cos(angle) * speed, Math.sin(angle) * speed, true);
        }
      }
    }

    update(dt) {
      this.time += dt;
      const { width, height } = this.engine;

      if (this.time < this.burstUntil && this.time >= this.nextBurst) {
        this.fireBurst();
        this.nextBurst += 0.28;
      }

      if (this.time > 0.6 && this.time < this.rainUntil) {
        const rate = 34 * clamp(width / 420, 0.7, 2.2);
        this.rainAccumulator += dt * rate;
        while (this.rainAccumulator >= 1) {
          this.rainAccumulator--;
          this.spawnBill(rand(-20, width + 20), -40, rand(-30, 30), rand(80, 160), false);
        }
      }

      const gravity = height * 1.25;
      for (const p of this.particles) {
        p.vy += gravity * dt;
        // Air drag: once falling, bills flutter down at terminal velocity.
        if (p.vy > 0) {
          const terminal = p.sprite === 'coin' ? 420 : 190;
          p.vy = Math.min(p.vy, terminal);
          p.vx *= 1 - Math.min(1, 1.8 * dt);
        }
        p.swayPhase += p.sway * dt;
        p.x += (p.vx + (p.vy > 0 ? Math.sin(p.swayPhase) * 60 : 0)) * dt;
        p.y += p.vy * dt;
        p.rotation += p.spin * dt;
        p.flip += p.flipSpeed * dt;
      }
      this.particles = this.particles.filter((p) => p.y < height + 80 || p.vy < 0);

      if (this.time > this.rainUntil && this.particles.length === 0) this.done = true;
      if (this.time > this.duration + 4) this.done = true;
    }

    draw(ctx) {
      const { width, height, sprites } = this.engine;

      // Golden flash when the guns start firing.
      if (this.time < 0.8) {
        const a = 0.35 * (1 - this.time / 0.8);
        const g = ctx.createRadialGradient(width / 2, height, 0, width / 2, height, height);
        g.addColorStop(0, `rgba(255, 215, 90, ${a})`);
        g.addColorStop(1, 'rgba(255, 215, 90, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }

      const fade = this.time > this.duration - 0.6 ? clamp((this.duration + 1.5 - this.time) / 2, 0, 1) : 1;
      for (const p of this.particles) {
        // cos(flip) squashes the sprite horizontally to fake a 3D tumble; the
        // back face uses a pre-mirrored sprite so the print never reads backwards.
        const flipX = Math.cos(p.flip);
        const back = flipX < 0;
        const sprite = sprites[p.sprite + (back ? 'Back' : '')];
        const scaleX = back ? Math.min(flipX, -0.12) : Math.max(flipX, 0.12);
        drawSprite(ctx, sprite, p.x, p.y, p.size, p.rotation, scaleX, fade);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Galaxy: impact -> cracks -> shatter -> spiral galaxy -> collapse
  // -------------------------------------------------------------------------

  class GalaxyEffect {
    constructor(engine, { count = 1 }) {
      this.engine = engine;
      this.time = 0;
      this.crackEnd = 1.5;
      this.shatterStart = 1.6;
      this.duration = clamp(9 + (count - 1) * 1.5, 9, 12);
      this.done = false;
      this.impactShake = false;
      this.buildGlass();
      this.buildGalaxy(count);
    }

    buildGlass() {
      const { width, height } = this.engine;
      const cx = width * rand(0.4, 0.6);
      const cy = height * rand(0.32, 0.48);
      const reach = Math.hypot(width, height);
      this.impact = { x: cx, y: cy };

      const rayCount = Math.round(rand(11, 15));
      const base = rand(0, TAU);
      this.rays = [];
      for (let i = 0; i < rayCount; i++) {
        const angle = base + (i / rayCount) * TAU + rand(-0.18, 0.18);
        const points = [{ x: cx, y: cy, d: 0 }];
        let a = angle;
        let d = 0;
        while (d < reach) {
          d += rand(18, 46);
          a += rand(-0.16, 0.16);
          points.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, d });
        }
        const branches = [];
        for (let b = 0; b < 2; b++) {
          if (Math.random() < 0.6) {
            const start = points[Math.floor(rand(2, Math.min(points.length - 1, 9)))];
            const ba = angle + (Math.random() < 0.5 ? -1 : 1) * rand(0.35, 0.8);
            const len = rand(30, 110);
            branches.push({ x1: start.x, y1: start.y, x2: start.x + Math.cos(ba) * len, y2: start.y + Math.sin(ba) * len, d: start.d });
          }
        }
        this.rays.push({ points, branches });
      }

      // Concentric rings connect the rays and split the glass into shards.
      const minDim = Math.min(width, height);
      this.ringRadii = [minDim * rand(0.07, 0.1), minDim * rand(0.2, 0.26), minDim * rand(0.38, 0.46), reach];
      const vertex = (ray, radius) => {
        const pts = ray.points;
        for (let i = 1; i < pts.length; i++) {
          if (pts[i].d >= radius) {
            const prev = pts[i - 1];
            const t = (radius - prev.d) / (pts[i].d - prev.d);
            return { x: prev.x + (pts[i].x - prev.x) * t, y: prev.y + (pts[i].y - prev.y) * t };
          }
        }
        return pts[pts.length - 1];
      };

      this.shards = [];
      for (let k = 0; k < this.ringRadii.length; k++) {
        for (let i = 0; i < rayCount; i++) {
          const a = this.rays[i];
          const b = this.rays[(i + 1) % rayCount];
          const outer = [vertex(a, this.ringRadii[k]), vertex(b, this.ringRadii[k])];
          const inner = k === 0 ? [{ x: cx, y: cy }] : [vertex(b, this.ringRadii[k - 1]), vertex(a, this.ringRadii[k - 1])];
          const poly = [...outer, ...inner];
          const center = poly.reduce((acc, p) => ({ x: acc.x + p.x / poly.length, y: acc.y + p.y / poly.length }), { x: 0, y: 0 });
          const away = Math.atan2(center.y - cy, center.x - cx);
          this.shards.push({
            poly: poly.map((p) => ({ x: p.x - center.x, y: p.y - center.y })),
            x: center.x,
            y: center.y,
            vx: Math.cos(away) * rand(40, 160),
            vy: Math.sin(away) * rand(40, 120) - rand(60, 180),
            rotation: 0,
            spin: rand(-2.5, 2.5),
            delay: (k / this.ringRadii.length) * 0.25 + rand(0, 0.12),
            tint: rand(0.05, 0.16)
          });
        }
      }
      this.ringVertices = this.ringRadii.slice(0, 3).map((r) => this.rays.map((ray) => vertex(ray, r)));
    }

    buildGalaxy(count) {
      const { width, height } = this.engine;
      const radius = Math.min(width, height) * 0.46;
      this.galaxyRadius = radius;
      this.arms = 3 + Math.min(count - 1, 2);
      this.stars = [];
      const starCount = Math.round(clamp((width * height) / 260, 600, 1400));
      const palette = [
        [255, 255, 255],
        [196, 170, 255],
        [140, 180, 255],
        [255, 150, 220],
        [120, 230, 255]
      ];
      for (let i = 0; i < starCount; i++) {
        const arm = i % this.arms;
        const r = Math.pow(Math.random(), 0.7) * radius;
        const spread = (1 - r / radius) * 0.5 + 0.15;
        const angle = (arm / this.arms) * TAU + (r / radius) * 4.2 + rand(-spread, spread);
        const color = r < radius * 0.15 ? [255, 240, 210] : palette[Math.floor(Math.random() * palette.length)];
        this.stars.push({
          r,
          angle,
          size: rand(0.6, r < radius * 0.2 ? 2.4 : 1.8),
          color: `rgb(${color[0]},${color[1]},${color[2]})`,
          twinkle: rand(0, TAU),
          speed: 0.35 * Math.sqrt(radius / Math.max(r, radius * 0.05)) * 0.35
        });
      }
      this.background = Array.from({ length: 160 }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        size: rand(0.4, 1.4),
        twinkle: rand(0, TAU)
      }));
      this.nebulae = Array.from({ length: 5 }, (_, i) => ({
        angle: (i / 5) * TAU + rand(-0.3, 0.3),
        dist: rand(0.15, 0.55) * radius,
        size: rand(0.55, 0.95) * radius,
        sprite: i % 2 ? 'glowPink' : 'glowPurple'
      }));
      this.shootingStars = [];
    }

    update(dt) {
      this.time += dt;
      const t = this.time;

      if (!this.impactShake) {
        this.impactShake = true;
        this.engine.shake(16, 0.6);
      }
      if (t >= this.shatterStart) {
        for (const s of this.shards) {
          if (t - this.shatterStart < s.delay) continue;
          s.vy += 900 * dt;
          s.x += s.vx * dt;
          s.y += s.vy * dt;
          s.rotation += s.spin * dt;
        }
      }
      if (t > 3 && t < this.duration - 1.5 && Math.random() < dt * 0.9) {
        const { width, height } = this.engine;
        this.shootingStars.push({ x: rand(0, width), y: rand(0, height * 0.4), life: 0, angle: rand(0.3, 0.9), speed: rand(500, 800) });
      }
      for (const s of this.shootingStars) s.life += dt;
      this.shootingStars = this.shootingStars.filter((s) => s.life < 0.8);

      if (t >= this.duration) this.done = true;
    }

    draw(ctx) {
      const t = this.time;
      this.drawGalaxy(ctx);
      if (t < this.shatterStart) this.drawCracks(ctx);
      else this.drawShards(ctx);

      // Impact flash.
      if (t < 0.35) {
        const { width, height } = this.engine;
        ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * (1 - t / 0.35)})`;
        ctx.fillRect(0, 0, width, height);
      }
    }

    drawCracks(ctx) {
      const progress = easeOutCubic(this.time / 0.55);
      const reach = Math.hypot(this.engine.width, this.engine.height) * progress;
      const glass = 0.08 * clamp(this.time / 0.3, 0, 1);

      ctx.save();
      ctx.fillStyle = `rgba(200, 220, 255, ${glass})`;
      ctx.fillRect(0, 0, this.engine.width, this.engine.height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const strokeRays = (style, width, offset) => {
        ctx.strokeStyle = style;
        ctx.lineWidth = width;
        ctx.beginPath();
        for (const ray of this.rays) {
          ctx.moveTo(ray.points[0].x + offset, ray.points[0].y + offset);
          for (const p of ray.points) {
            if (p.d > reach) break;
            ctx.lineTo(p.x + offset, p.y + offset);
          }
          for (const b of ray.branches) {
            if (b.d > reach) continue;
            ctx.moveTo(b.x1 + offset, b.y1 + offset);
            ctx.lineTo(b.x2 + offset, b.y2 + offset);
          }
        }
        ctx.stroke();
      };

      strokeRays('rgba(0, 0, 0, 0.35)', 2.5, 1.2);
      ctx.shadowColor = 'rgba(190, 220, 255, 0.9)';
      ctx.shadowBlur = 8;
      strokeRays('rgba(255, 255, 255, 0.92)', 1.4, 0);

      // Rings appear once the rays have passed them.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      this.ringVertices.forEach((ring, k) => {
        if (this.ringRadii[k] > reach) return;
        ring.forEach((p, i) => {
          const next = ring[(i + 1) % ring.length];
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(next.x, next.y);
        });
      });
      ctx.stroke();

      // Bright point of impact.
      const g = ctx.createRadialGradient(this.impact.x, this.impact.y, 0, this.impact.x, this.impact.y, 40);
      g.addColorStop(0, 'rgba(255, 255, 255, 0.9)');
      g.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.shadowBlur = 0;
      ctx.fillStyle = g;
      ctx.fillRect(this.impact.x - 40, this.impact.y - 40, 80, 80);
      ctx.restore();
    }

    drawShards(ctx) {
      const since = this.time - this.shatterStart;
      const alpha = clamp(1 - since / 1.6, 0, 1);
      if (alpha <= 0) return;
      ctx.save();
      ctx.lineJoin = 'round';
      for (const s of this.shards) {
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(s.rotation);
        ctx.beginPath();
        s.poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fillStyle = `rgba(210, 225, 255, ${s.tint * alpha})`;
        ctx.fill();
        ctx.strokeStyle = `rgba(255, 255, 255, ${0.8 * alpha})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    }

    drawGalaxy(ctx) {
      const t = this.time;
      const since = t - this.shatterStart + 0.2;
      if (since <= 0) return;
      const { width, height, sprites } = this.engine;
      const fadeIn = easeOutCubic(since / 1.2);
      const collapseStart = this.duration - 1.6;
      const collapse = easeInCubic((t - collapseStart) / 1.4);
      const alpha = fadeIn * (1 - clamp((t - (this.duration - 0.5)) / 0.5, 0, 1));
      const cx = width / 2;
      const cy = height * 0.42;
      const scale = (0.6 + 0.4 * fadeIn) * (1 - collapse * 0.97);
      const rotation = t * 0.18 + collapse * 3;

      ctx.save();
      ctx.globalAlpha = alpha;

      // Deep-space backdrop.
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(width, height) * 0.7);
      bg.addColorStop(0, 'rgba(40, 14, 80, 0.92)');
      bg.addColorStop(0.55, 'rgba(12, 4, 34, 0.9)');
      bg.addColorStop(1, 'rgba(2, 0, 10, 0.86)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = '#fff';
      for (const s of this.background) {
        ctx.globalAlpha = alpha * (0.35 + 0.65 * Math.abs(Math.sin(t * 2 + s.twinkle)));
        ctx.fillRect(s.x, s.y, s.size, s.size);
      }

      ctx.translate(cx, cy);
      ctx.scale(scale, scale * 0.62);

      for (const n of this.nebulae) {
        const a = n.angle + rotation * 0.6;
        ctx.globalAlpha = alpha * 0.55;
        ctx.drawImage(
          sprites[n.sprite].canvas,
          Math.cos(a) * n.dist - n.size,
          Math.sin(a) * n.dist - n.size,
          n.size * 2,
          n.size * 2
        );
      }

      for (const s of this.stars) {
        const a = s.angle + rotation * s.speed * 3;
        const x = Math.cos(a) * s.r;
        const y = Math.sin(a) * s.r;
        ctx.globalAlpha = alpha * (0.55 + 0.45 * Math.sin(t * 3 + s.twinkle));
        ctx.fillStyle = s.color;
        ctx.fillRect(x - s.size / 2, y - s.size / 2, s.size, s.size);
      }

      const core = this.galaxyRadius * (0.32 + 0.05 * Math.sin(t * 2.4));
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprites.glowCore.canvas, -core, -core, core * 2, core * 2);
      ctx.restore();

      // Shooting stars.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      for (const s of this.shootingStars) {
        const k = s.life / 0.8;
        const x = s.x + Math.cos(s.angle) * s.speed * s.life;
        const y = s.y + Math.sin(s.angle) * s.speed * s.life;
        const tail = 90;
        const g = ctx.createLinearGradient(x, y, x - Math.cos(s.angle) * tail, y - Math.sin(s.angle) * tail);
        g.addColorStop(0, `rgba(255, 255, 255, ${alpha * (1 - k)})`);
        g.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.strokeStyle = g;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(s.angle) * tail, y - Math.sin(s.angle) * tail);
        ctx.stroke();
      }
      ctx.restore();

      // Final flash as the galaxy collapses into a point.
      if (collapse > 0.85) {
        const k = (collapse - 0.85) / 0.15;
        const r = 30 + k * Math.max(width, height) * 0.6;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, `rgba(255, 245, 255, ${0.8 * (1 - k * 0.6) * alpha})`);
        g.addColorStop(1, 'rgba(200, 160, 255, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Roses: a light, gentle fall of roses and loose petals
  // -------------------------------------------------------------------------

  class RoseEffect {
    constructor(engine, { count = 1 }) {
      this.engine = engine;
      this.time = 0;
      this.done = false;
      this.particles = [];
      this.toSpawn = clamp(Math.round(6 + Math.sqrt(count) * 5), 8, 55);
      this.spawnWindow = clamp(1.5 + count * 0.08, 1.5, 4.5);
      this.spawned = 0;
    }

    update(dt) {
      this.time += dt;
      const { width, height } = this.engine;
      const target = Math.min(this.toSpawn, Math.ceil((this.time / this.spawnWindow) * this.toSpawn));
      while (this.spawned < target) {
        this.spawned++;
        const petal = Math.random() < 0.45;
        const base = clamp(width / 11, 26, 56);
        this.particles.push({
          x: rand(0, width),
          y: rand(-80, -20),
          vy: rand(55, 105),
          size: petal ? base * rand(0.35, 0.5) : base * rand(0.75, 1.1),
          sprite: petal ? 'petal' : 'rose',
          rotation: rand(-0.5, 0.5),
          spin: rand(-0.8, 0.8),
          sway: rand(0.6, 1.4),
          swayAmp: rand(18, 45),
          phase: rand(0, TAU),
          flip: rand(0, TAU)
        });
      }
      for (const p of this.particles) {
        p.phase += p.sway * dt;
        p.y += p.vy * dt;
        p.x += Math.cos(p.phase) * p.swayAmp * dt;
        p.rotation += p.spin * dt;
        p.flip += dt * 2;
      }
      this.particles = this.particles.filter((p) => p.y < height + 90);
      if (this.spawned >= this.toSpawn && this.particles.length === 0) this.done = true;
    }

    draw(ctx) {
      const { sprites, height } = this.engine;
      for (const p of this.particles) {
        const fade = clamp((height + 60 - p.y) / 160, 0, 1);
        const flipX = p.sprite === 'petal' ? Math.cos(p.flip) : 1;
        drawSprite(ctx, sprites[p.sprite], p.x, p.y, p.size, p.rotation, Math.abs(flipX) < 0.2 ? 0.2 : flipX, 0.95 * fade);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------------

  const EFFECT_TYPES = {
    moneygun: MoneyRainEffect,
    galaxy: GalaxyEffect,
    rose: RoseEffect
  };

  class EffectsEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.effects = [];
      this.running = false;
      this.lastFrame = 0;
      this.shakeAmount = 0;
      this.shakeTime = 0;
      this.width = 0;
      this.height = 0;
      this.frame = this.frame.bind(this);
      this.resize();
      new ResizeObserver(() => this.resize()).observe(canvas);
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.width = Math.max(1, rect.width);
      this.height = Math.max(1, rect.height);
      this.canvas.width = Math.round(this.width * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.dpr !== dpr) {
        this.dpr = dpr;
        const bill = createBillSprite(dpr);
        const coin = createCoinSprite(dpr);
        this.sprites = {
          bill,
          billBack: mirrorSprite(bill),
          coin,
          coinBack: mirrorSprite(coin),
          rose: createRoseSprite(dpr),
          petal: createPetalSprite(dpr),
          glowCore: createGlowSprite(dpr, 'rgba(255, 236, 255, 0.95)'),
          glowPurple: createGlowSprite(dpr, 'rgba(140, 70, 255, 0.55)'),
          glowPink: createGlowSprite(dpr, 'rgba(255, 70, 190, 0.45)')
        };
      }
    }

    /** Starts an effect; returns its approximate duration in milliseconds. */
    play(type, options = {}) {
      const Effect = EFFECT_TYPES[type];
      if (!Effect) return 0;
      const effect = new Effect(this, { count: Math.max(1, Number(options.count) || 1) });
      this.effects.push(effect);
      if (!this.running) {
        this.running = true;
        this.lastFrame = performance.now();
        requestAnimationFrame(this.frame);
      }
      return Math.round((effect.duration || 5) * 1000);
    }

    shake(amount, seconds) {
      this.shakeAmount = Math.max(this.shakeAmount, amount);
      this.shakeTime = Math.max(this.shakeTime, seconds);
    }

    clear() {
      this.effects = [];
    }

    frame(now) {
      const dt = Math.min((now - this.lastFrame) / 1000, 0.05);
      this.lastFrame = now;
      const { ctx } = this;

      ctx.save();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);

      if (this.shakeTime > 0) {
        this.shakeTime -= dt;
        const k = this.shakeAmount * Math.max(this.shakeTime, 0);
        ctx.translate(rand(-k, k), rand(-k, k));
      }

      for (const effect of this.effects) {
        effect.update(dt);
        ctx.save();
        effect.draw(ctx);
        ctx.restore();
      }
      ctx.restore();

      this.effects = this.effects.filter((e) => !e.done);
      if (this.effects.length) {
        requestAnimationFrame(this.frame);
      } else {
        this.running = false;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      }
    }
  }

  window.OverlayEffects = { EffectsEngine, EFFECT_TYPES: Object.keys(EFFECT_TYPES) };
})();
