/**
 * Canvas effects engine for the overlay.
 *
 *   engine.play('moneygun', { count })  -> money guns fire from the corners,
 *                                          bills rain down and pile up
 *   engine.play('galaxy',   { count })  -> screen cracks and shatters, warp
 *                                          jump, spiral galaxy, supernova
 *   engine.play('rose',     { count })  -> roses and petals drift down with
 *                                          depth of field
 *
 * play() returns the effect duration in ms. Everything is sized relative to
 * the window, and sprites are re-rendered at the displayed resolution so they
 * stay sharp at any window size. The render loop only runs while an effect is
 * alive, and particle counts drop automatically if frames get slow.
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const rand = (min, max) => min + Math.random() * (max - min);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOutCubic = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
  const easeInCubic = (t) => Math.pow(clamp(t, 0, 1), 3);
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const rgba = (rgb, a) => `rgba(${rgb},${a})`;

  const FONT = '"Segoe UI", Helvetica, Arial, sans-serif';

  // -------------------------------------------------------------------------
  // Canvas helpers
  // -------------------------------------------------------------------------

  /** Offscreen canvas drawn in logical units; `scale` sets its pixel density. */
  function makeCanvas(width, height, scale) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(width * scale));
    canvas.height = Math.max(1, Math.ceil(height * scale));
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    return { canvas, ctx, width, height };
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

  function radialBlob(ctx, x, y, size, color, alpha) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, size);
    g.addColorStop(0, rgba(color, alpha));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x - size, y - size, size * 2, size * 2);
  }

  /** Draws a sprite centred at (x, y), `width` wide (height keeps the sprite's ratio). */
  function drawSprite(ctx, sprite, x, y, width, rotation, scaleX, scaleY, alpha) {
    if (alpha <= 0.003) return;
    const height = (width * sprite.height) / sprite.width;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.scale(scaleX, scaleY);
    ctx.drawImage(sprite.canvas, -width / 2, -height / 2, width, height);
    ctx.restore();
  }

  function drawGlow(ctx, sprite, x, y, size, alpha) {
    if (alpha <= 0.003 || size <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(sprite.canvas, x - size / 2, y - size / 2, size, size);
  }

  /** Soft light rays fanning out from a point (additive). */
  function drawRays(ctx, x, y, radius, count, rotation, alpha, rgb) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x, y);
    ctx.rotate(rotation);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    g.addColorStop(0, rgba(rgb, alpha));
    g.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = g;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU;
      const spread = (TAU / count) * (0.18 + 0.12 * Math.sin(i * 2.7));
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, a - spread, a + spread);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Sprites: pre-rendered once per resolution, so frames are just drawImage
  // -------------------------------------------------------------------------

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

  /** Same shape filled with one colour: drawn on top at low alpha to shade a sprite. */
  function tintSprite(sprite, color) {
    const canvas = document.createElement('canvas');
    canvas.width = sprite.canvas.width;
    canvas.height = sprite.canvas.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(sprite.canvas, 0, 0);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return { canvas, width: sprite.width, height: sprite.height };
  }

  /** Out-of-focus copy for depth of field. */
  function blurSprite(sprite, blur, scale) {
    const pad = blur * 3;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil((sprite.width + pad * 2) * scale);
    canvas.height = Math.ceil((sprite.height + pad * 2) * scale);
    const ctx = canvas.getContext('2d');
    ctx.filter = `blur(${blur * scale}px)`;
    ctx.drawImage(sprite.canvas, pad * scale, pad * scale);
    return { canvas, width: sprite.width + pad * 2, height: sprite.height + pad * 2 };
  }

  function createGlow(scale, rgb) {
    const size = 64;
    const { canvas, ctx } = makeCanvas(size, size, scale);
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, rgba(rgb, 1));
    g.addColorStop(0.25, rgba(rgb, 0.5));
    g.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return { canvas, width: size, height: size };
  }

  /** Four-point star flare for sparkles. */
  function createGlint(scale, rgb) {
    const size = 40;
    const c = size / 2;
    const { canvas, ctx } = makeCanvas(size, size, scale);
    radialBlob(ctx, c, c, c * 0.45, rgb, 0.8);
    const g = ctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, rgba(rgb, 0.9));
    g.addColorStop(1, rgba(rgb, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(c, 0);
    ctx.lineTo(c + 1.4, c - 1.4);
    ctx.lineTo(size, c);
    ctx.lineTo(c + 1.4, c + 1.4);
    ctx.lineTo(c, size);
    ctx.lineTo(c - 1.4, c + 1.4);
    ctx.lineTo(0, c);
    ctx.lineTo(c - 1.4, c - 1.4);
    ctx.closePath();
    ctx.fill();
    return { canvas, width: size, height: size };
  }

  function sealShape(ctx, x, y, r, color, points) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (let i = 0; i < points * 2; i++) {
      const a = (i / (points * 2)) * TAU;
      const rr = i % 2 ? r * 0.82 : r;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(230, 240, 225, 0.9)';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.55, 0, TAU);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.font = `800 ${r * 0.8}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$', x, y + 0.5);
    ctx.restore();
  }

  function rosette(ctx, x, y, r, color) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.5;
    for (let i = 0; i < 12; i++) {
      ctx.beginPath();
      ctx.ellipse(x, y, r, r * 0.35, (i / 12) * Math.PI, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** A banknote with paper texture, guilloche borders, portrait and seals. */
  function createBill(scale, back) {
    const pad = 6;
    const W = 150;
    const H = 64;
    const { canvas, ctx } = makeCanvas(W + pad * 2, H + pad * 2, scale);
    ctx.translate(pad, pad);
    const ink = back ? '#1c5634' : '#2b583a';

    // Paper with a soft baked drop shadow.
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.38)';
    ctx.shadowBlur = 5 * scale;
    ctx.shadowOffsetY = 2 * scale;
    const paper = ctx.createLinearGradient(0, 0, W, H);
    if (back) {
      paper.addColorStop(0, '#c4dbbb');
      paper.addColorStop(0.5, '#a8c69e');
      paper.addColorStop(1, '#bcd6b2');
    } else {
      paper.addColorStop(0, '#e4edd9');
      paper.addColorStop(0.5, '#cbdbbe');
      paper.addColorStop(1, '#dce7d0');
    }
    ctx.fillStyle = paper;
    roundRect(ctx, 0, 0, W, H, 3);
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, 0, 0, W, H, 3);
    ctx.clip();

    // Paper fibres.
    for (let i = 0; i < 260; i++) {
      ctx.fillStyle = `rgba(40, 90, 50, ${rand(0.03, 0.09)})`;
      ctx.fillRect(rand(0, W), rand(0, H), rand(0.6, 3), 0.4);
    }

    // Borders and guilloche wave bands.
    ctx.strokeStyle = ink;
    ctx.lineWidth = 2;
    roundRect(ctx, 4, 4, W - 8, H - 8, 2);
    ctx.stroke();
    ctx.lineWidth = 0.6;
    roundRect(ctx, 7, 7, W - 14, H - 14, 1.5);
    ctx.stroke();
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.45;
    for (const y0 of [10.5, H - 10.5]) {
      for (const phase of [0, Math.PI]) {
        ctx.beginPath();
        for (let x = 8; x <= W - 8; x += 1) {
          const y = y0 + Math.sin(x * 0.42 + phase) * 1.8;
          if (x === 8) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    const cx = W / 2;
    const cy = H / 2;
    ctx.textBaseline = 'middle';
    if (!back) {
      // Engraved portrait oval.
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(cx, cy, 16, 21, 0, 0, TAU);
      const oval = ctx.createRadialGradient(cx, cy - 4, 2, cx, cy, 22);
      oval.addColorStop(0, '#f0f5e9');
      oval.addColorStop(1, '#a6bf97');
      ctx.fillStyle = oval;
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.clip();
      ctx.globalAlpha = 0.2;
      ctx.lineWidth = 0.45;
      for (let y = cy - 21; y < cy + 21; y += 1.5) {
        ctx.beginPath();
        ctx.moveTo(cx - 16, y);
        ctx.lineTo(cx + 16, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = ink;
      ctx.beginPath();
      ctx.ellipse(cx, cy - 4, 6.2, 7.6, 0, 0, TAU);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - 15, cy + 22);
      ctx.quadraticCurveTo(cx - 12, cy + 6, cx, cy + 5);
      ctx.quadraticCurveTo(cx + 12, cy + 6, cx + 15, cy + 22);
      ctx.fill();
      ctx.restore();

      sealShape(ctx, 31, cy, 9, ink, 16);
      sealShape(ctx, W - 31, cy, 9, '#3d6e4e', 16);

      ctx.fillStyle = ink;
      ctx.font = `800 12px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillText('100', 11, 16);
      ctx.fillText('100', 11, H - 15);
      ctx.textAlign = 'right';
      ctx.fillText('100', W - 11, 16);
      ctx.font = `900 15px ${FONT}`;
      ctx.fillText('100', W - 10, H - 16);

      ctx.fillStyle = ink;
      ctx.font = `700 5.5px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('ONE HUNDRED DOLLARS', cx, H - 8);
    } else {
      rosette(ctx, 26, cy, 12, ink);
      rosette(ctx, W - 26, cy, 12, ink);
      ctx.beginPath();
      ctx.ellipse(cx, cy, 31, 19, 0, 0, TAU);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = ink;
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.font = `900 24px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('100', cx, cy + 1);
      ctx.font = `700 5.5px ${FONT}`;
      ctx.fillText('LIVE GIFT', cx, H - 8);
    }

    // Vignette so the edges read as curved paper.
    const v = ctx.createRadialGradient(cx, cy, H * 0.4, cx, cy, W * 0.62);
    v.addColorStop(0, 'rgba(0, 0, 0, 0)');
    v.addColorStop(1, 'rgba(20, 40, 20, 0.24)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();

    return { canvas, width: W + pad * 2, height: H + pad * 2 };
  }

  /** Gold coin with a ridged rim, embossed "$" and a specular highlight. */
  function createCoin(scale) {
    const pad = 4;
    const S = 44;
    const { canvas, ctx } = makeCanvas(S + pad * 2, S + pad * 2, scale);
    ctx.translate(pad, pad);
    const c = S / 2;
    const r = S / 2 - 1;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 4 * scale;
    ctx.shadowOffsetY = 2 * scale;
    ctx.fillStyle = '#a86d05';
    ctx.beginPath();
    ctx.arc(c, c, r, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(255, 230, 150, 0.55)';
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 48; i++) {
      const a = (i / 48) * TAU;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * (r - 3), c + Math.sin(a) * (r - 3));
      ctx.lineTo(c + Math.cos(a) * (r - 0.5), c + Math.sin(a) * (r - 0.5));
      ctx.stroke();
    }

    const face = ctx.createRadialGradient(c * 0.7, c * 0.6, 1, c, c, r - 3);
    face.addColorStop(0, '#fff8cf');
    face.addColorStop(0.35, '#ffd84a');
    face.addColorStop(0.75, '#e3a91a');
    face.addColorStop(1, '#a86d05');
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(c, c, r - 3, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(140, 85, 0, 0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(c, c, r - 7, 0, TAU);
    ctx.stroke();

    ctx.font = `800 21px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(120, 70, 0, 0.85)';
    ctx.fillText('$', c + 0.8, c + 1.8);
    ctx.fillStyle = 'rgba(255, 245, 200, 0.9)';
    ctx.fillText('$', c - 0.6, c + 0.4);
    ctx.fillStyle = '#d99a12';
    ctx.fillText('$', c, c + 1);

    ctx.save();
    ctx.translate(c - 7, c - 9);
    ctx.rotate(-0.6);
    ctx.scale(1, 0.45);
    radialBlob(ctx, 0, 0, 10, '255,255,255', 0.6);
    ctx.restore();

    return { canvas, width: S + pad * 2, height: S + pad * 2 };
  }

  function petalPath(ctx, r) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-r * 0.75, -r * 0.15, -r * 0.7, -r * 1.05, 0, -r);
    ctx.bezierCurveTo(r * 0.7, -r * 1.05, r * 0.75, -r * 0.15, 0, 0);
    ctx.closePath();
  }

  /** Layered rose bloom: three rings of shaded petals around a spiral bud. */
  function paintBloom(ctx, cx, cy, R) {
    radialBlob(ctx, cx + 2, cy + 3, R * 1.1, '0,0,0', 0.35);
    const rings = [
      { n: 6, r: R, rot: 0, dark: '#4a0010', mid: '#9c1030', light: '#e23a58' },
      { n: 5, r: R * 0.78, rot: 0.55, dark: '#5c0014', mid: '#b0142f', light: '#f04a66' },
      { n: 4, r: R * 0.56, rot: 1.1, dark: '#6a0016', mid: '#c01a36', light: '#ff5c78' }
    ];
    for (const ring of rings) {
      for (let i = 0; i < ring.n; i++) {
        const a = ring.rot + (i / ring.n) * TAU;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(a);
        const g = ctx.createLinearGradient(0, 0, 0, -ring.r);
        g.addColorStop(0, ring.dark);
        g.addColorStop(0.55, ring.mid);
        g.addColorStop(1, ring.light);
        petalPath(ctx, ring.r);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 150, 170, 0.3)';
        ctx.lineWidth = 0.7;
        ctx.stroke();
        // Rolled petal edge.
        ctx.beginPath();
        ctx.moveTo(-ring.r * 0.35, -ring.r * 0.88);
        ctx.quadraticCurveTo(0, -ring.r * 1.02, ring.r * 0.35, -ring.r * 0.88);
        ctx.strokeStyle = 'rgba(255, 195, 205, 0.5)';
        ctx.lineWidth = 1.1;
        ctx.stroke();
        ctx.restore();
      }
    }
    // Spiral bud.
    const bud = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.34);
    bud.addColorStop(0, '#3a000c');
    bud.addColorStop(1, '#a01230');
    ctx.fillStyle = bud;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.34, 0, TAU);
    ctx.fill();
    ctx.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const a = k * 1.7;
      ctx.strokeStyle = k % 2 ? 'rgba(255, 110, 135, 0.7)' : 'rgba(70, 0, 15, 0.8)';
      ctx.lineWidth = R * 0.05;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * R * 0.04, cy + Math.sin(a) * R * 0.04, R * (0.3 - k * 0.06), a, a + Math.PI * 1.25);
      ctx.stroke();
    }
    // Light from the top-left.
    radialBlob(ctx, cx - R * 0.35, cy - R * 0.4, R * 0.7, '255,205,215', 0.22);
  }

  function leafShape(ctx, x, y, length, width, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const g = ctx.createLinearGradient(0, -width, 0, width);
    g.addColorStop(0, '#6cc05a');
    g.addColorStop(1, '#2a6e2c');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(length * 0.45, -width, length, 0);
    ctx.quadraticCurveTo(length * 0.45, width, 0, 0);
    ctx.fill();
    ctx.strokeStyle = 'rgba(20, 60, 20, 0.6)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(length * 0.92, 0);
    for (let i = 1; i <= 3; i++) {
      const vx = (length * i) / 4.2;
      ctx.moveTo(vx, 0);
      ctx.lineTo(vx + length * 0.14, -width * 0.55);
      ctx.moveTo(vx, 0);
      ctx.lineTo(vx + length * 0.14, width * 0.55);
    }
    ctx.stroke();
    ctx.restore();
  }

  function createRose(scale) {
    const W = 64;
    const H = 128;
    const { canvas, ctx } = makeCanvas(W, H, scale);
    const cx = W / 2;
    const cy = 30;

    // Stem: dark body plus a highlight so it reads as round.
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1f5a24';
    ctx.lineWidth = 3.6;
    ctx.beginPath();
    ctx.moveTo(cx, cy + 12);
    ctx.bezierCurveTo(cx + 5, cy + 40, cx - 4, cy + 70, cx - 1, H - 6);
    ctx.stroke();
    ctx.strokeStyle = '#6cbf5a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 0.8, cy + 12);
    ctx.bezierCurveTo(cx + 4, cy + 40, cx - 5, cy + 70, cx - 2, H - 6);
    ctx.stroke();
    // Thorns.
    ctx.fillStyle = '#2f6d2c';
    for (const [x, y, dir] of [[cx + 2.4, 66, 1], [cx - 2.6, 90, -1], [cx + 0.8, 108, 1]]) {
      ctx.beginPath();
      ctx.moveTo(x, y - 2.5);
      ctx.lineTo(x + dir * 4, y - 3.5);
      ctx.lineTo(x, y + 1.5);
      ctx.fill();
    }
    leafShape(ctx, cx + 1, 72, 22, 7, -0.55);
    leafShape(ctx, cx - 2, 96, 18, 6, 3.6);

    // Sepals under the bloom.
    ctx.fillStyle = '#2e7d32';
    for (let i = 0; i < 5; i++) {
      const a = Math.PI / 2 + (i - 2) * 0.45;
      ctx.beginPath();
      ctx.moveTo(cx, cy + 8);
      ctx.quadraticCurveTo(cx + Math.cos(a - 0.3) * 10, cy + 8 + Math.sin(a - 0.3) * 10, cx + Math.cos(a) * 15, cy + 8 + Math.sin(a) * 13);
      ctx.quadraticCurveTo(cx + Math.cos(a + 0.3) * 8, cy + 8 + Math.sin(a + 0.3) * 8, cx, cy + 8);
      ctx.fill();
    }
    paintBloom(ctx, cx, cy, 22);
    return { canvas, width: W, height: H };
  }

  function createBloom(scale) {
    const S = 64;
    const { canvas, ctx } = makeCanvas(S, S, scale);
    paintBloom(ctx, S / 2, S / 2, 26);
    return { canvas, width: S, height: S };
  }

  function createPetal(scale) {
    const W = 30;
    const H = 22;
    const { canvas, ctx } = makeCanvas(W, H, scale);
    const g = ctx.createRadialGradient(4, H / 2, 1, W * 0.45, H / 2, W * 0.7);
    g.addColorStop(0, '#5a0014');
    g.addColorStop(0.45, '#c8173a');
    g.addColorStop(1, '#ff5a78');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(2, H / 2);
    ctx.bezierCurveTo(W * 0.3, -1, W * 0.85, 1, W - 2, H / 2);
    ctx.bezierCurveTo(W * 0.85, H - 1, W * 0.3, H + 1, 2, H / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 175, 190, 0.45)';
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255, 200, 210, 0.25)';
    ctx.beginPath();
    ctx.moveTo(3, H / 2);
    ctx.quadraticCurveTo(W * 0.45, H / 2 - 1.5, W * 0.72, H / 2);
    ctx.stroke();
    return { canvas, width: W, height: H };
  }

  function buildSprites(scale) {
    const bill = createBill(scale, false);
    // The back is pre-mirrored because it's drawn with a negative x-scale.
    const billBack = mirrorSprite(createBill(scale, true));
    const coin = createCoin(scale);
    const rose = createRose(scale);
    const bloom = createBloom(scale);
    const petal = createPetal(scale);
    return {
      bill,
      billBack,
      billDark: tintSprite(bill, '#0b1a0f'),
      billBackDark: tintSprite(billBack, '#0b1a0f'),
      coin,
      coinDark: tintSprite(coin, '#3a2400'),
      glintGold: createGlint(scale, '255,222,130'),
      glintWhite: createGlint(scale, '225,235,255'),
      glintPink: createGlint(scale, '255,170,205'),
      glowGold: createGlow(scale, '255,196,80'),
      glowWhite: createGlow(scale, '255,255,255'),
      glowBlue: createGlow(scale, '120,160,255'),
      glowPurple: createGlow(scale, '160,90,255'),
      glowPink: createGlow(scale, '255,90,190'),
      rose,
      roseFar: blurSprite(rose, 1.8, scale),
      bloom,
      bloomFar: blurSprite(bloom, 1.6, scale),
      petal,
      petalFar: blurSprite(petal, 1.2, scale),
      petalBokeh: blurSprite(petal, 3.5, scale)
    };
  }

  // -------------------------------------------------------------------------
  // Money Gun: guns fire from the bottom corners, bills rain and pile up
  // -------------------------------------------------------------------------

  const PILE_COLUMNS = 28;

  class MoneyGunEffect {
    constructor(engine, { count = 1 }) {
      this.engine = engine;
      this.time = 0;
      this.done = false;
      this.intensity = 1 + Math.min(count - 1, 3) * 0.25;
      this.duration = clamp(7.5 + (count - 1) * 1.2, 7.5, 11);
      this.burstUntil = 1.9 + Math.min(count - 1, 3) * 0.5;
      this.rainUntil = this.duration - 2.4;
      this.nextBurst = 0.05;
      this.rainAcc = 0;
      this.layers = [[], [], []]; // far, mid, near
      this.sparks = [];
      this.muzzles = [];
      this.maxParticles = Math.round(480 * engine.quality * Math.min(engine.spread, 1.6));
      this.pile = makeCanvas(engine.width, engine.height, engine.dpr);
      this.pileHeights = new Float32Array(PILE_COLUMNS);
      this.pileCount = 0;
      engine.flash('255, 214, 90', 0.3, 0.6);
    }

    get particleCount() {
      return this.layers[0].length + this.layers[1].length + this.layers[2].length;
    }

    spawn(x, y, vx, vy, z, fromGun) {
      if (this.particleCount >= this.maxParticles) return;
      const coin = Math.random() < 0.18;
      const layer = z < 0.72 ? 0 : z < 1 ? 1 : 2;
      this.layers[layer].push({
        x,
        y,
        px: x,
        py: y,
        vx,
        vy,
        z,
        coin,
        fromGun,
        size: this.engine.size * 0.19 * z * (coin ? 0.3 : rand(0.9, 1.08)),
        rotation: rand(0, TAU),
        spin: rand(-2.4, 2.4),
        flip: rand(0, TAU),
        flipSpeed: rand(2.5, 6.5) * (coin ? 1.8 : 1),
        sway: rand(0.8, 1.9),
        swayPhase: rand(0, TAU)
      });
    }

    fireBurst(side) {
      const { width, height, quality, unit } = this.engine;
      const ox = side < 0 ? width * 0.1 : width * 0.9;
      this.muzzles.push({ x: ox, y: height * 0.98, t: 0 });
      const shots = Math.round(rand(8, 12) * this.intensity * quality);
      for (let i = 0; i < shots; i++) {
        const angle = -Math.PI / 2 - side * rand(0.1, 0.6);
        const speed = rand(1.0, 1.45) * height;
        this.spawn(ox + rand(-8, 8), height * 1.02, Math.cos(angle) * speed, Math.sin(angle) * speed, rand(0.95, 1.3), true);
      }
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 - side * rand(-0.2, 0.9);
        const s = rand(0.35, 0.8) * height;
        this.sparks.push({
          x: ox,
          y: height * 0.98,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s,
          life: 0,
          max: rand(0.25, 0.6),
          size: rand(1, 2.2) * unit,
          glint: false
        });
      }
    }

    update(dt) {
      this.time += dt;
      const t = this.time;
      const { width, height, quality, size, spread } = this.engine;

      if (t < this.burstUntil && t >= this.nextBurst) {
        this.fireBurst(-1);
        this.fireBurst(1);
        this.nextBurst += 0.24;
        this.engine.shake(2.2, 0.12);
      }

      if (t > 0.5 && t < this.rainUntil) {
        this.rainAcc += dt * 30 * this.intensity * quality * spread;
        while (this.rainAcc >= 1) {
          this.rainAcc--;
          this.spawn(rand(-0.05, 1.05) * width, -height * 0.08, rand(-20, 20), rand(30, 80), rand(0.45, 1.25), false);
        }
      }

      const gravity = height * 1.3;
      for (const layer of this.layers) {
        for (const p of layer) {
          p.px = p.x;
          p.py = p.y;
          p.vy += gravity * dt;
          if (p.vy > 0) {
            // Air drag: paper settles into a slow flutter, coins drop faster.
            const terminal = height * (p.coin ? 0.6 : 0.2) * (0.55 + 0.45 * p.z);
            if (p.vy > terminal) p.vy = lerp(p.vy, terminal, Math.min(1, dt * 5));
            p.vx *= 1 - Math.min(1, 1.5 * dt);
          }
          p.swayPhase += p.sway * dt;
          const flutter = p.vy > 0 && !p.coin ? Math.sin(p.swayPhase) * size * 0.11 * p.z : 0;
          p.x += (p.vx + flutter) * dt;
          p.y += p.vy * dt;
          p.rotation += p.spin * dt * (p.vy > 0 ? 0.55 : 1) + (flutter / size) * dt * 2;
          p.flip += p.flipSpeed * dt;

          if (p.coin && Math.random() < dt * 1.2) {
            this.sparks.push({ x: p.x, y: p.y, vx: 0, vy: 0, life: 0, max: rand(0.3, 0.5), size: p.size * 1.4, glint: true });
          }
          if (!p.coin && p.z >= 1 && p.vy > 0 && this.pileCount < 150 && t < this.duration - 1.2) {
            const col = clamp(Math.floor((p.x / width) * PILE_COLUMNS), 0, PILE_COLUMNS - 1);
            const ground = height - this.pileHeights[col] - p.size * 0.08;
            if (p.y >= ground) {
              this.land(p, ground, col);
              p.dead = true;
            }
          }
        }
      }
      for (let i = 0; i < this.layers.length; i++) {
        this.layers[i] = this.layers[i].filter((p) => !p.dead && p.y < height + p.size);
      }

      for (const s of this.sparks) {
        if (!s.glint) s.vy += gravity * 0.6 * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.life += dt;
      }
      this.sparks = this.sparks.filter((s) => s.life < s.max);
      for (const m of this.muzzles) m.t += dt;
      this.muzzles = this.muzzles.filter((m) => m.t < 0.18);

      if (t >= this.duration + 0.2) this.done = true;
    }

    /** Bills that reach the bottom lie flat and build up a pile. */
    land(p, ground, col) {
      const { sprites, height } = this.engine;
      const ctx = this.pile.ctx;
      const back = Math.random() < 0.4;
      const rotation = rand(-0.3, 0.3) + (Math.random() < 0.5 ? 0 : Math.PI);
      drawSprite(ctx, back ? sprites.billBack : sprites.bill, p.x, ground, p.size, rotation, 1, 0.5, 1);
      drawSprite(ctx, back ? sprites.billBackDark : sprites.billDark, p.x, ground, p.size, rotation, 1, 0.5, rand(0.05, 0.3));
      const add = p.size * 0.045;
      for (let c = col - 1; c <= col + 1; c++) {
        if (c < 0 || c >= PILE_COLUMNS) continue;
        this.pileHeights[c] = Math.min(height * 0.075, this.pileHeights[c] + (c === col ? add : add * 0.5));
      }
      this.pileCount++;
    }

    draw(ctx) {
      const t = this.time;
      const { width, height, sprites } = this.engine;
      const fade = 1 - clamp((t - (this.duration - 1)) / 1.1, 0, 1);

      const rayAlpha = 0.3 * easeOutCubic(t / 0.35) * (1 - clamp((t - 1.6) / 1.4, 0, 1));
      if (rayAlpha > 0) drawRays(ctx, width / 2, height * 1.05, height * 1.1, 14, t * 0.12, rayAlpha, '255,210,110');

      for (const p of this.layers[0]) this.drawParticle(ctx, p, fade);
      for (const p of this.layers[1]) this.drawParticle(ctx, p, fade);
      if (this.pileCount) {
        ctx.globalAlpha = fade;
        ctx.drawImage(this.pile.canvas, 0, 0, width, height);
        ctx.globalAlpha = 1;
      }
      for (const p of this.layers[2]) this.drawParticle(ctx, p, fade);

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const m of this.muzzles) {
        const k = 1 - m.t / 0.18;
        drawGlow(ctx, sprites.glowGold, m.x, m.y, this.engine.size * 0.5 * k, 0.9 * k);
        drawGlow(ctx, sprites.glowWhite, m.x, m.y, this.engine.size * 0.18 * k, k);
      }
      ctx.lineCap = 'round';
      for (const s of this.sparks) {
        const k = Math.sin(Math.PI * (s.life / s.max));
        if (s.glint) {
          drawGlow(ctx, sprites.glintGold, s.x, s.y, s.size * k, k * fade);
        } else {
          ctx.globalAlpha = (1 - s.life / s.max) * fade;
          ctx.strokeStyle = 'rgb(255, 214, 120)';
          ctx.lineWidth = s.size;
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x - s.vx * 0.03, s.y - s.vy * 0.03);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    drawParticle(ctx, p, fade) {
      const { sprites } = this.engine;
      const cos = Math.cos(p.flip);
      const back = cos < 0 && !p.coin;
      let scaleX;
      if (p.coin) scaleX = Math.max(Math.abs(cos), 0.1);
      else scaleX = back ? Math.min(cos, -0.08) : Math.max(cos, 0.08);
      const key = p.coin ? 'coin' : back ? 'billBack' : 'bill';
      const alpha = clamp(0.5 + 0.5 * p.z, 0, 1) * fade;

      // Motion trail while bills fly out of the guns.
      if (p.fromGun && p.vy < 0) {
        const dx = p.x - p.px;
        const dy = p.y - p.py;
        drawSprite(ctx, sprites[key], p.x - dx * 2.5, p.y - dy * 2.5, p.size, p.rotation, scaleX, 1, alpha * 0.18);
        drawSprite(ctx, sprites[key], p.x - dx * 1.2, p.y - dy * 1.2, p.size, p.rotation, scaleX, 1, alpha * 0.3);
      }
      drawSprite(ctx, sprites[key], p.x, p.y, p.size, p.rotation, scaleX, 1, alpha);

      // Darker when edge-on to the light, and when further away.
      const shade = (1 - Math.abs(cos)) * 0.55 + (1 - clamp(p.z, 0, 1)) * 0.3;
      if (shade > 0.04) drawSprite(ctx, sprites[`${key}Dark`], p.x, p.y, p.size, p.rotation, scaleX, 1, alpha * shade);
    }
  }

  // -------------------------------------------------------------------------
  // Galaxy: impact -> cracks -> slow-motion shatter -> warp jump ->
  // spiral galaxy -> collapse -> supernova
  // -------------------------------------------------------------------------

  class GalaxyEffect {
    constructor(engine, { count = 1 }) {
      this.engine = engine;
      this.time = 0;
      this.done = false;
      this.duration = clamp(10.5 + (count - 1) * 1.5, 10.5, 13.5);
      this.shatterAt = 1.2;
      this.warpStart = 1.3;
      this.warpEnd = 2.3;
      this.collapseStart = this.duration - 2;
      this.novaAt = this.duration - 0.6;
      this.arms = count >= 3 ? 4 : count === 2 ? 3 : 2;
      const { width, height } = engine;
      this.maxDim = Math.hypot(width, height);
      this.center = { x: width / 2, y: height * 0.44 };
      this.buildGlass();
      this.buildSpace();
      this.dust = [];
      this.shootingStars = [];
      this.nova = null;
      engine.flash('255, 255, 255', 0.9, 0.4);
      engine.shake(16, 0.7);
    }

    buildGlass() {
      const { width, height, unit } = this.engine;
      const cx = width * rand(0.4, 0.6);
      const cy = height * rand(0.35, 0.5);
      this.impact = { x: cx, y: cy };
      const reach = this.maxDim;

      const rayCount = Math.round(rand(12, 16));
      const base = rand(0, TAU);
      this.rays = [];
      for (let i = 0; i < rayCount; i++) {
        const angle = base + (i / rayCount) * TAU + rand(-0.18, 0.18);
        const points = [{ x: cx, y: cy, d: 0 }];
        let a = angle;
        let d = 0;
        while (d < reach) {
          d += rand(18, 46) * unit;
          a += rand(-0.15, 0.15);
          points.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, d });
        }
        const branches = [];
        for (let b = 0; b < 2; b++) {
          if (Math.random() < 0.6) {
            const start = points[Math.floor(rand(2, Math.min(points.length - 1, 9)))];
            const ba = angle + (Math.random() < 0.5 ? -1 : 1) * rand(0.35, 0.8);
            const len = rand(30, 110) * unit;
            branches.push({ x1: start.x, y1: start.y, x2: start.x + Math.cos(ba) * len, y2: start.y + Math.sin(ba) * len, d: start.d });
          }
        }
        this.rays.push({ points, branches });
      }

      const minDim = Math.min(width, height);
      this.ringRadii = [minDim * rand(0.07, 0.1), minDim * rand(0.2, 0.26), minDim * rand(0.38, 0.46), reach];
      const vertex = (ray, radius) => {
        const pts = ray.points;
        for (let i = 1; i < pts.length; i++) {
          if (pts[i].d >= radius) {
            const prev = pts[i - 1];
            const k = (radius - prev.d) / (pts[i].d - prev.d);
            return { x: prev.x + (pts[i].x - prev.x) * k, y: prev.y + (pts[i].y - prev.y) * k };
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
          const path = new Path2D();
          let r = 0;
          poly.forEach((p, idx) => {
            const x = p.x - center.x;
            const y = p.y - center.y;
            r = Math.max(r, Math.hypot(x, y));
            if (idx) path.lineTo(x, y);
            else path.moveTo(x, y);
          });
          path.closePath();
          const away = Math.atan2(center.y - cy, center.x - cx);
          this.shards.push({
            path,
            r,
            x: center.x,
            y: center.y,
            vx: Math.cos(away) * rand(60, 220) * unit,
            vy: Math.sin(away) * rand(40, 160) * unit - rand(80, 220) * unit,
            rotation: 0,
            spin: rand(-2.5, 2.5),
            spinY: rand(0, TAU),
            spinYSpeed: rand(-4, 4),
            delay: (k / this.ringRadii.length) * 0.2 + rand(0, 0.1)
          });
        }
      }
      this.ringVertices = this.ringRadii.slice(0, 3).map((radius) => this.rays.map((ray) => vertex(ray, radius)));
    }

    /** Pre-renders the galaxy disk and the star backdrop once per effect. */
    buildSpace() {
      const { width, height, dpr, quality } = this.engine;
      const R = Math.min(width, height) * 0.5;
      this.R = R;
      const arms = this.arms;
      const armAngle = (arm, r) => (arm / arms) * TAU + (r / R) * 3.4;

      const disk = makeCanvas(R * 2, R * 2, Math.min(dpr, 900 / R));
      const ctx = disk.ctx;
      ctx.translate(R, R);

      // Nebula clouds along the arms.
      ctx.globalCompositeOperation = 'lighter';
      const nebula = ['150,80,255', '90,120,255', '255,80,190', '80,210,255', '190,90,255'];
      for (let i = 0; i < 240; i++) {
        const r = Math.pow(Math.random(), 0.8) * R * 0.95;
        const a = armAngle(i % arms, r) + gauss() * 0.35;
        radialBlob(ctx, Math.cos(a) * r, Math.sin(a) * r, R * rand(0.1, 0.24) * (1 - (r / R) * 0.4), pick(nebula), rand(0.08, 0.15));
      }
      // Dark dust lanes on the trailing edge of each arm.
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < 120; i++) {
        const r = rand(0.12, 0.85) * R;
        const a = armAngle(i % arms, r) - 0.2 + gauss() * 0.06;
        radialBlob(ctx, Math.cos(a) * r, Math.sin(a) * r, R * rand(0.04, 0.09), '10,0,20', rand(0.2, 0.35));
      }
      // Stars: mostly along the arms, the rest in a diffuse halo.
      ctx.globalCompositeOperation = 'lighter';
      const starCount = Math.round(7000 * quality);
      for (let i = 0; i < starCount; i++) {
        const inArm = Math.random() < 0.78;
        const r = inArm ? Math.pow(Math.random(), 0.7) * R : Math.pow(Math.random(), 0.45) * R;
        const a = inArm ? armAngle(i % arms, r) + gauss() * (0.16 + 0.3 * (1 - r / R)) : rand(0, TAU);
        const warm = r < R * 0.2 || Math.random() < 0.15;
        const color = warm ? '255,232,200' : pick(['215,225,255', '190,205,255', '255,190,235', '170,235,255']);
        const size = rand(0.4, r < R * 0.25 ? 1.8 : 1.3);
        ctx.fillStyle = rgba(color, rand(0.35, 1));
        ctx.fillRect(Math.cos(a) * r, Math.sin(a) * r, size, size);
      }
      for (let i = 0; i < 60; i++) {
        const r = Math.pow(Math.random(), 0.8) * R;
        const a = armAngle(i % arms, r) + gauss() * 0.2;
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        radialBlob(ctx, x, y, R * rand(0.012, 0.03), pick(['255,255,255', '180,200,255', '255,200,240']), 0.9);
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
      }
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.38);
      core.addColorStop(0, 'rgba(255,252,240,1)');
      core.addColorStop(0.12, 'rgba(255,226,180,0.85)');
      core.addColorStop(0.35, 'rgba(255,160,140,0.32)');
      core.addColorStop(0.65, 'rgba(170,90,255,0.12)');
      core.addColorStop(1, 'rgba(120,60,255,0)');
      ctx.fillStyle = core;
      ctx.fillRect(-R * 0.38, -R * 0.38, R * 0.76, R * 0.76);
      this.disk = disk.canvas;

      // Distant stars and faint nebulae across the whole window.
      const bg = makeCanvas(width, height, Math.min(dpr, 1.5));
      bg.ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 4; i++) {
        radialBlob(bg.ctx, rand(0, width), rand(0, height), this.maxDim * rand(0.3, 0.55), pick(['120,60,220', '60,90,220', '200,60,170']), rand(0.06, 0.1));
      }
      for (let i = 0; i < 450; i++) {
        bg.ctx.fillStyle = `rgba(255,255,255,${rand(0.2, 0.9)})`;
        const size = rand(0.4, 1.4);
        bg.ctx.fillRect(rand(0, width), rand(0, height), size, size);
      }
      this.backdrop = bg.canvas;

      this.twinkles = Array.from({ length: 26 }, () => ({
        x: rand(0, width),
        y: rand(0, height),
        size: rand(0.03, 0.07) * this.engine.size,
        phase: rand(0, TAU),
        speed: rand(1.5, 3.5),
        sprite: pick(['glintWhite', 'glintWhite', 'glintPink'])
      }));
      this.warp = Array.from({ length: Math.round(260 * quality) }, () => ({
        a: rand(0, TAU),
        r0: rand(0.02, 0.35) * this.maxDim,
        speed: rand(0.7, 1.5),
        width: rand(0.6, 2),
        color: pick(['255,255,255', '170,200,255', '220,170,255'])
      }));
    }

    update(dt) {
      this.time += dt;
      const t = this.time;
      const { width, height } = this.engine;

      // Glass dust trickles out of the cracks before the break.
      if (t > 0.3 && t < this.shatterAt && Math.random() < dt * 40) {
        const p = pick(pick(this.rays).points);
        if (p.d < this.maxDim * 0.6) this.dust.push({ x: p.x, y: p.y, vx: rand(-20, 20), vy: rand(0, 40), life: 0, size: rand(0.8, 2) * this.engine.unit });
      }
      for (const d of this.dust) {
        d.vy += height * 1.2 * dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.life += dt;
      }
      this.dust = this.dust.filter((d) => d.life < 1.2 && d.y < height);

      if (t >= this.shatterAt) {
        for (const s of this.shards) {
          const local = t - this.shatterAt - s.delay;
          if (local < 0) continue;
          // The first half second of the break plays in slow motion.
          const sdt = dt * (local < 0.5 ? 0.22 : 1);
          s.vy += height * 1.3 * sdt;
          s.x += s.vx * sdt;
          s.y += s.vy * sdt;
          s.rotation += s.spin * sdt;
          s.spinY += s.spinYSpeed * sdt;
        }
      }

      if (t > this.warpEnd && t < this.collapseStart && Math.random() < dt * 0.8) {
        this.shootingStars.push({ x: rand(0, width), y: rand(0, height * 0.4), life: 0, angle: rand(0.3, 0.9), speed: rand(0.9, 1.6) * width });
      }
      for (const s of this.shootingStars) s.life += dt;
      this.shootingStars = this.shootingStars.filter((s) => s.life < 0.8);

      if (t >= this.novaAt && !this.nova) {
        this.nova = { t: 0 };
        this.engine.flash('255, 240, 255', 0.8, 0.7);
        this.engine.shake(10, 0.5);
      }
      if (this.nova) this.nova.t += dt;

      if (t >= this.duration) this.done = true;
    }

    draw(ctx) {
      const t = this.time;
      this.drawSpace(ctx);
      if (t < this.shatterAt) this.drawCracks(ctx);
      else this.drawShards(ctx);
      this.drawDust(ctx);
      if (t < 0.7) this.drawShockwave(ctx, this.impact.x, this.impact.y, t / 0.7, '255,255,255');
      if (this.nova) this.drawShockwave(ctx, this.center.x, this.center.y, this.nova.t / 0.9, '230,190,255');
    }

    drawShockwave(ctx, x, y, k, rgb) {
      if (k >= 1) return;
      const { unit } = this.engine;
      const r = easeOutCubic(k) * this.maxDim * 0.75;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba(rgb, 0.45 * (1 - k));
      ctx.lineWidth = (1 - k) * 26 * unit;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = rgba(rgb, 0.8 * (1 - k));
      ctx.lineWidth = (1 - k) * 4 * unit;
      ctx.stroke();
      ctx.restore();
    }

    drawCracks(ctx) {
      const t = this.time;
      const { width, height, sprites, unit } = this.engine;
      const reach = this.maxDim * easeOutCubic(t / 0.5);

      const cracks = new Path2D();
      for (const ray of this.rays) {
        cracks.moveTo(ray.points[0].x, ray.points[0].y);
        for (const p of ray.points) {
          if (p.d > reach) break;
          cracks.lineTo(p.x, p.y);
        }
        for (const b of ray.branches) {
          if (b.d > reach) continue;
          cracks.moveTo(b.x1, b.y1);
          cracks.lineTo(b.x2, b.y2);
        }
      }
      const rings = new Path2D();
      this.ringVertices.forEach((ring, k) => {
        if (this.ringRadii[k] > reach) return;
        ring.forEach((p, i) => {
          const next = ring[(i + 1) % ring.length];
          rings.moveTo(p.x, p.y);
          rings.lineTo(next.x, next.y);
        });
      });

      ctx.save();
      ctx.fillStyle = `rgba(200, 220, 255, ${0.07 * clamp(t / 0.25, 0, 1)})`;
      ctx.fillRect(0, 0, width, height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // Depth: a dark underside offset from each crack.
      ctx.translate(1.2 * unit, 1.2 * unit);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.lineWidth = 2.6 * unit;
      ctx.stroke(cracks);
      ctx.translate(-1.2 * unit, -1.2 * unit);

      // Chromatic fringes, like light splitting in broken glass.
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1.4 * unit;
      ctx.translate(1.6 * unit, 0);
      ctx.strokeStyle = 'rgba(255, 60, 90, 0.45)';
      ctx.stroke(cracks);
      ctx.stroke(rings);
      ctx.translate(-3.2 * unit, 0);
      ctx.strokeStyle = 'rgba(60, 220, 255, 0.45)';
      ctx.stroke(cracks);
      ctx.stroke(rings);
      ctx.translate(1.6 * unit, 0);

      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowColor = 'rgba(200, 230, 255, 0.9)';
      ctx.shadowBlur = 8;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = 1.3 * unit;
      ctx.stroke(cracks);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 1 * unit;
      ctx.stroke(rings);
      ctx.shadowBlur = 0;

      // Glare at the point of impact.
      ctx.globalCompositeOperation = 'lighter';
      const pulse = 0.8 + 0.2 * Math.sin(t * 20);
      drawGlow(ctx, sprites.glowWhite, this.impact.x, this.impact.y, this.engine.size * 0.28 * pulse, 0.8);
      drawGlow(ctx, sprites.glintWhite, this.impact.x, this.impact.y, this.engine.size * 0.45 * pulse, 0.9);
      ctx.restore();
    }

    drawShards(ctx) {
      const alpha = clamp(1 - (this.time - this.shatterAt) / 1.8, 0, 1);
      if (alpha <= 0) return;
      const { unit } = this.engine;
      ctx.save();
      ctx.lineJoin = 'round';
      for (const s of this.shards) {
        const shine = 0.5 + 0.5 * Math.abs(Math.sin(s.spinY * 1.3));
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(s.rotation);
        ctx.scale(Math.cos(s.spinY) || 0.01, 1);
        const g = ctx.createLinearGradient(-s.r, -s.r, s.r, s.r);
        g.addColorStop(0, rgba('255,255,255', 0.32 * shine * alpha));
        g.addColorStop(0.5, rgba('200,220,255', 0.06 * alpha));
        g.addColorStop(1, rgba('255,255,255', 0.16 * shine * alpha));
        ctx.fillStyle = g;
        ctx.fill(s.path);
        ctx.strokeStyle = rgba('255,255,255', 0.85 * alpha);
        ctx.lineWidth = 1.2 * unit;
        ctx.stroke(s.path);
        ctx.restore();
      }
      ctx.restore();
    }

    drawDust(ctx) {
      if (!this.dust.length) return;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = '#fff';
      for (const d of this.dust) {
        ctx.globalAlpha = 1 - d.life / 1.2;
        ctx.fillRect(d.x, d.y, d.size, d.size);
      }
      ctx.restore();
    }

    drawSpace(ctx) {
      const t = this.time;
      if (t < this.warpStart - 0.1) return;
      const { width, height, sprites } = this.engine;
      // Follow the window if it's resized mid-effect.
      this.center = { x: width / 2, y: height * 0.44 };
      this.R = Math.min(width, height) * 0.5;
      this.maxDim = Math.hypot(width, height);
      const fadeIn = easeOutCubic((t - (this.warpStart - 0.1)) / 0.5);
      const fadeOut = 1 - clamp((t - (this.novaAt + 0.05)) / (this.duration - this.novaAt - 0.05), 0, 1);
      const alpha = fadeIn * fadeOut;
      if (alpha <= 0) return;
      const { x: cx, y: cy } = this.center;
      const R = this.R;

      ctx.save();
      ctx.globalAlpha = alpha;
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, this.maxDim * 0.7);
      bg.addColorStop(0, 'rgba(34, 12, 70, 0.95)');
      bg.addColorStop(0.5, 'rgba(10, 4, 32, 0.93)');
      bg.addColorStop(1, 'rgba(2, 0, 8, 0.9)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);

      // Distant stars with a slow push-in.
      ctx.globalCompositeOperation = 'lighter';
      const zoom = 1 + (t - this.warpStart) * 0.012;
      ctx.globalAlpha = alpha * 0.9;
      ctx.drawImage(this.backdrop, cx - cx * zoom, cy - cy * zoom, width * zoom, height * zoom);

      // Hyperspace jump: streaks accelerate out from the centre.
      const w = (t - this.warpStart) / (this.warpEnd - this.warpStart);
      if (w > 0 && w < 1.3) {
        const k = clamp(w, 0, 1);
        const travel = easeInCubic(k) * this.maxDim * 1.6;
        const len = Math.sin(Math.PI * k) * this.maxDim * 0.3;
        ctx.globalAlpha = alpha * (1 - clamp((w - 0.85) / 0.4, 0, 1));
        ctx.lineCap = 'round';
        for (const s of this.warp) {
          const r1 = s.r0 + travel * s.speed;
          const r2 = r1 + len * s.speed + 2;
          const cos = Math.cos(s.a);
          const sin = Math.sin(s.a);
          ctx.strokeStyle = rgba(s.color, 0.8);
          ctx.lineWidth = s.width * (0.6 + k);
          ctx.beginPath();
          ctx.moveTo(cx + cos * r1, cy + sin * r1);
          ctx.lineTo(cx + cos * r2, cy + sin * r2);
          ctx.stroke();
        }
      }

      // The galaxy: tilted disk, spinning, collapsing at the end.
      const appear = easeOutCubic((t - (this.warpEnd - 0.5)) / 1.6);
      if (appear > 0) {
        const collapse = easeInCubic((t - this.collapseStart) / (this.novaAt - this.collapseStart));
        const scale = lerp(0.25, 1, appear) * (1 - collapse * 0.97);
        const rot = (t - this.warpEnd) * 0.2 + collapse * collapse * 7;
        ctx.save();
        ctx.globalAlpha = alpha * appear;
        ctx.translate(cx, cy);
        ctx.rotate(-0.38);
        ctx.scale(scale, scale * 0.56);
        ctx.rotate(rot);
        ctx.drawImage(this.disk, -R, -R, R * 2, R * 2);
        // A faster inner layer gives a sense of differential rotation.
        ctx.rotate(rot * 0.6);
        ctx.globalAlpha = alpha * appear * 0.35;
        ctx.drawImage(this.disk, -R * 0.62, -R * 0.62, R * 1.24, R * 1.24);
        ctx.restore();

        // Core glow with an anamorphic lens flare and ghosts.
        const pulse = 0.85 + 0.15 * Math.sin(t * 3.1) + collapse * 0.8;
        const coreSize = R * 0.55 * pulse * (1 - collapse * 0.5);
        drawGlow(ctx, sprites.glowWhite, cx, cy, coreSize, alpha * appear);
        const flareW = R * 2.6 * pulse;
        const flareH = R * 0.07;
        ctx.globalAlpha = alpha * appear * 0.7;
        ctx.drawImage(sprites.glowBlue.canvas, cx - flareW / 2, cy - flareH / 2, flareW, flareH);
        ctx.drawImage(sprites.glowWhite.canvas, cx - flareW * 0.3, cy - flareH * 0.3, flareW * 0.6, flareH * 0.6);
        const lx = width * 0.8;
        const ly = height * 0.18;
        for (const [k, size, key] of [[0.4, 0.07, 'glowPurple'], [0.75, 0.12, 'glowBlue'], [1.3, 0.05, 'glowPink']]) {
          drawGlow(ctx, sprites[key], cx - (lx - cx) * k, cy - (ly - cy) * k, this.engine.size * size, alpha * appear * 0.3);
        }
      }

      for (const tw of this.twinkles) {
        const k = Math.max(0, Math.sin(t * tw.speed + tw.phase));
        if (k < 0.05) continue;
        drawGlow(ctx, sprites[tw.sprite], tw.x, tw.y, tw.size * (0.6 + 0.4 * k), alpha * k);
      }

      ctx.lineCap = 'round';
      for (const s of this.shootingStars) {
        const k = s.life / 0.8;
        const x = s.x + Math.cos(s.angle) * s.speed * s.life;
        const y = s.y + Math.sin(s.angle) * s.speed * s.life;
        const tail = this.engine.size * 0.22;
        const g = ctx.createLinearGradient(x, y, x - Math.cos(s.angle) * tail, y - Math.sin(s.angle) * tail);
        g.addColorStop(0, `rgba(255, 255, 255, ${1 - k})`);
        g.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = g;
        ctx.lineWidth = 2 * this.engine.unit;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - Math.cos(s.angle) * tail, y - Math.sin(s.angle) * tail);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // Roses: gentle fall of roses, blooms and petals with depth of field
  // -------------------------------------------------------------------------

  const ROSE_SIZES = { rose: 0.13, bloom: 0.085, petal: 0.05 };

  class RoseEffect {
    constructor(engine, { count = 1 }) {
      this.engine = engine;
      this.time = 0;
      this.done = false;
      this.toSpawn = Math.round(clamp(8 + Math.sqrt(count) * 6, 10, 70) * engine.quality * engine.spread);
      this.spawnWindow = clamp(1.8 + count * 0.08, 1.8, 5);
      this.duration = this.spawnWindow + 8;
      this.spawned = 0;
      this.particles = [];
      this.sparkles = [];
    }

    spawn() {
      const { width, height } = this.engine;
      const roll = Math.random();
      const kind = roll < 0.3 ? 'rose' : roll < 0.45 ? 'bloom' : 'petal';
      const bokeh = kind === 'petal' && Math.random() < 0.08;
      const z = bokeh ? rand(1.7, 2.2) : rand(0.5, 1.2);
      const sprite = bokeh ? 'petalBokeh' : z < 0.75 ? `${kind}Far` : kind;
      const base = ROSE_SIZES[kind] * this.engine.size;
      const p = {
        kind,
        z,
        sprite,
        bokeh,
        x: rand(-0.05, 1.05) * width,
        y: -rand(0.05, 0.15) * height - base * z,
        vy: height * rand(0.085, 0.125) * (0.55 + 0.45 * z),
        size: base * z * rand(0.85, 1.15),
        rotation: rand(-0.6, 0.6),
        spin: rand(-0.6, 0.6) * (kind === 'petal' ? 2 : 1),
        sway: rand(0.5, 1.2),
        swayAmp: this.engine.size * rand(0.03, 0.07) * z,
        phase: rand(0, TAU),
        flipA: rand(0, TAU),
        flipB: rand(0, TAU),
        flipSpeed: rand(1.5, 3.5)
      };
      // Keep far-to-near drawing order.
      let i = this.particles.length;
      while (i > 0 && this.particles[i - 1].z > z) i--;
      this.particles.splice(i, 0, p);
    }

    update(dt) {
      this.time += dt;
      const { width, height } = this.engine;
      const target = Math.min(this.toSpawn, Math.ceil((this.time / this.spawnWindow) * this.toSpawn));
      while (this.spawned < target) {
        this.spawned++;
        this.spawn();
      }
      for (const p of this.particles) {
        p.phase += p.sway * dt;
        p.y += p.vy * dt;
        p.x += Math.cos(p.phase) * p.swayAmp * dt;
        p.rotation += (p.spin + Math.sin(p.phase) * 0.4) * dt;
        p.flipA += p.flipSpeed * dt;
        p.flipB += p.flipSpeed * 0.7 * dt;
        if (p.kind !== 'petal' && p.z > 0.8 && Math.random() < dt * 0.6) {
          this.sparkles.push({ x: p.x + rand(-0.4, 0.4) * p.size, y: p.y + rand(-0.4, 0.4) * p.size, life: 0, max: rand(0.5, 0.9), size: rand(0.03, 0.05) * this.engine.size });
        }
      }
      this.particles = this.particles.filter((p) => p.y < height + p.size);
      for (const s of this.sparkles) s.life += dt;
      this.sparkles = this.sparkles.filter((s) => s.life < s.max);
      if (this.spawned >= this.toSpawn && !this.particles.length && !this.sparkles.length) this.done = true;
    }

    draw(ctx) {
      const { width, height, sprites } = this.engine;

      // Soft rosy light from above while the roses fall.
      const env = clamp(this.time / 1.2, 0, 1) * clamp(this.particles.length / 6, 0, 1);
      if (env > 0) {
        const g = ctx.createRadialGradient(width / 2, -height * 0.1, 0, width / 2, -height * 0.1, height * 0.6);
        g.addColorStop(0, `rgba(255, 120, 160, ${0.14 * env})`);
        g.addColorStop(1, 'rgba(255, 120, 160, 0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height * 0.6);
      }

      for (const p of this.particles) {
        const fade = clamp((height + p.size - p.y) / (height * 0.15), 0, 1);
        const alpha = (p.bokeh ? 0.55 : p.z < 0.75 ? 0.75 : 0.97) * fade;
        let scaleX = 1;
        let scaleY = 1;
        if (p.kind === 'petal') {
          // Petals tumble on two axes.
          scaleX = Math.cos(p.flipA);
          if (Math.abs(scaleX) < 0.15) scaleX = scaleX < 0 ? -0.15 : 0.15;
          scaleY = 0.7 + 0.3 * Math.sin(p.flipB);
        } else {
          scaleX = 0.85 + 0.15 * Math.cos(p.flipA);
        }
        drawSprite(ctx, sprites[p.sprite], p.x, p.y, p.size, p.rotation, scaleX, scaleY, alpha);
      }

      if (this.sparkles.length) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const s of this.sparkles) {
          const k = Math.sin(Math.PI * (s.life / s.max));
          drawGlow(ctx, sprites.glintPink, s.x, s.y, s.size * k, 0.8 * k);
        }
        ctx.restore();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Engine
  // -------------------------------------------------------------------------

  const EFFECT_TYPES = {
    moneygun: MoneyGunEffect,
    galaxy: GalaxyEffect,
    rose: RoseEffect
  };

  class EffectsEngine {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.effects = [];
      this.flashes = [];
      this.running = false;
      this.lastFrame = 0;
      this.shakeAmount = 0;
      this.shakeTime = 0;
      this.width = 0;
      this.height = 0;
      this.dpr = 1;
      this.quality = 1; // 0.45..1, lowered automatically when frames get slow
      this.frameAvg = 1 / 60;
      this.qualityTimer = 0;
      this.frame = this.frame.bind(this);
      this.resize();
      new ResizeObserver(() => this.resize()).observe(canvas);
    }

    /** Width of the largest 9:16 box that fits the window: effects are sized by it, so they look the same in any window shape. */
    get size() {
      return Math.min(this.width, this.height * (9 / 16));
    }

    /** How many 9:16 boxes wide the window is (1 for 9:16); more particles fill wider windows. */
    get spread() {
      return clamp(this.width / this.size, 1, 2.5);
    }

    /** Size unit that scales with the window (1 at 420px). */
    get unit() {
      return this.size / 420;
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.width = Math.max(1, rect.width);
      this.height = Math.max(1, rect.height);
      this.dpr = dpr;
      this.canvas.width = Math.round(this.width * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      // Render sprites at the size they're shown, so they stay sharp in big windows.
      const spriteScale = Math.round(dpr * clamp(this.size / 400, 1, 3) * 4) / 4;
      if (spriteScale !== this.spriteScale) {
        this.spriteScale = spriteScale;
        this.sprites = buildSprites(spriteScale);
      }
    }

    /** Starts an effect; returns its approximate duration in milliseconds. */
    play(type, options = {}) {
      const Effect = EFFECT_TYPES[type];
      if (!Effect) return 0;
      const effect = new Effect(this, { count: Math.max(1, Number(options.count) || 1) });
      this.effects.push(effect);
      this.start();
      return Math.round((effect.duration || 5) * 1000);
    }

    shake(amount, seconds) {
      this.shakeAmount = Math.max(this.shakeAmount, amount);
      this.shakeTime = Math.max(this.shakeTime, seconds);
    }

    /** Full-window colour flash that fades out (drawn above the effects). */
    flash(rgb, alpha, seconds) {
      this.flashes.push({ rgb, alpha, duration: seconds, t: 0 });
      this.start();
    }

    clear() {
      this.effects = [];
      this.flashes = [];
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.lastFrame = performance.now();
      requestAnimationFrame(this.frame);
    }

    adaptQuality(raw) {
      if (raw <= 0 || raw > 0.5) return;
      this.frameAvg = lerp(this.frameAvg, raw, 0.05);
      this.qualityTimer += raw;
      if (this.qualityTimer < 1) return;
      this.qualityTimer = 0;
      if (this.frameAvg > 1 / 40) this.quality = Math.max(0.45, this.quality - 0.1);
      else if (this.frameAvg < 1 / 55) this.quality = Math.min(1, this.quality + 0.05);
    }

    frame(now) {
      const raw = (now - this.lastFrame) / 1000;
      this.lastFrame = now;
      const dt = Math.min(raw, 0.05);
      this.adaptQuality(raw);
      const { ctx } = this;

      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.width, this.height);
      ctx.save();

      if (this.shakeTime > 0) {
        this.shakeTime -= dt;
        const k = this.shakeAmount * this.unit * Math.max(this.shakeTime, 0);
        ctx.translate(rand(-k, k), rand(-k, k));
        if (this.shakeTime <= 0) this.shakeAmount = 0;
      }

      for (const effect of this.effects) {
        effect.update(dt);
        ctx.save();
        effect.draw(ctx);
        ctx.restore();
      }

      for (const f of this.flashes) {
        f.t += dt;
        const a = f.alpha * Math.pow(1 - clamp(f.t / f.duration, 0, 1), 2);
        if (a <= 0) continue;
        ctx.fillStyle = rgba(f.rgb, a);
        ctx.fillRect(-40, -40, this.width + 80, this.height + 80);
      }
      ctx.restore();

      this.effects = this.effects.filter((e) => !e.done);
      this.flashes = this.flashes.filter((f) => f.t < f.duration);
      if (this.effects.length || this.flashes.length) {
        requestAnimationFrame(this.frame);
      } else {
        this.running = false;
        ctx.clearRect(0, 0, this.width, this.height);
      }
    }
  }

  window.OverlayEffects = { EffectsEngine, EFFECT_TYPES: Object.keys(EFFECT_TYPES) };
})();
