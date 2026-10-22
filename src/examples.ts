// Sample bitmaps drawn at runtime, so the app ships no third-party images.

export interface Example {
  id: string;
  label: string;
  draw: () => HTMLCanvasElement;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number, inner: number, points = 5) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? inner : outer;
    const a = (Math.PI / points) * i - Math.PI / 2;
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.closePath();
}

function badge(): HTMLCanvasElement {
  const [c, ctx] = canvas(640, 640);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 640, 640);
  ctx.fillStyle = '#1d3557';
  ctx.beginPath();
  ctx.arc(320, 320, 270, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#f1faee';
  ctx.beginPath();
  ctx.arc(320, 320, 232, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e63946';
  ctx.beginPath();
  ctx.arc(320, 320, 205, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffd166';
  star(ctx, 320, 285, 120, 52);
  ctx.fill();
  ctx.fillStyle = '#f1faee';
  ctx.font = '800 58px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('SUPER', 320, 455);
  for (let i = 0; i < 12; i++) {
    const a = (Math.PI * 2 * i) / 12;
    ctx.beginPath();
    ctx.arc(320 + Math.cos(a) * 251, 320 + Math.sin(a) * 251, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

function landscape(): HTMLCanvasElement {
  const [c, ctx] = canvas(800, 520);
  const sky = ctx.createLinearGradient(0, 0, 0, 360);
  sky.addColorStop(0, '#2b2d6e');
  sky.addColorStop(0.55, '#e76f51');
  sky.addColorStop(1, '#f4a261');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 800, 520);
  ctx.fillStyle = '#ffe8a3';
  ctx.beginPath();
  ctx.arc(560, 300, 70, 0, Math.PI * 2);
  ctx.fill();
  const ridge = (base: number, amp: number, color: string, seed: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, 520);
    for (let x = 0; x <= 800; x += 8) {
      const y = base - amp * (0.6 * Math.sin(x / 90 + seed) + 0.4 * Math.sin(x / 37 + seed * 2.3));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(800, 520);
    ctx.closePath();
    ctx.fill();
  };
  ridge(330, 50, '#6d597a', 1);
  ridge(380, 40, '#355070', 2.4);
  ridge(440, 30, '#1b263b', 4.1);
  ctx.strokeStyle = '#1b263b';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const [bx, by] of [[220, 120], [260, 150], [300, 110]]) {
    ctx.beginPath();
    ctx.moveTo(bx - 14, by);
    ctx.quadraticCurveTo(bx - 7, by - 9, bx, by);
    ctx.quadraticCurveTo(bx + 7, by - 9, bx + 14, by);
    ctx.stroke();
  }
  return c;
}

function sprite(): HTMLCanvasElement {
  const art = [
    '................',
    '.....KKKKKK.....',
    '...KKRRRRWWKK...',
    '..KWWRRRRWWWWK..',
    '.KWWRRRRRRWWWWK.',
    '.KWRRWWWWRRWWWK.',
    'KRRRWWWWWWRRRRRK',
    'KRRRWWWWWWRRRWRK',
    'KWRRWWWWWWRRWWWK',
    'KWWRRWWWWRRRWWWK',
    'KWWRRRRRRRRRRWRK',
    '.KKKKKKKKKKKKKK.',
    '...KSSKSSKSSK...',
    '...KSSSSSSSSK...',
    '....KSSSSSSK....',
    '.....KKKKKK.....',
  ];
  const colors: Record<string, string> = { K: '#1a1423', R: '#d62839', W: '#fbfef9', S: '#f2cc8f' };
  const scale = 12;
  const [c, ctx] = canvas(16 * scale, 16 * scale);
  ctx.fillStyle = '#8ecae6';
  ctx.fillRect(0, 0, c.width, c.height);
  art.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (colors[ch]) {
        ctx.fillStyle = colors[ch];
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    });
  });
  return c;
}

function ink(): HTMLCanvasElement {
  const [c, ctx] = canvas(640, 480);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 640, 480);
  ctx.strokeStyle = '#111111';
  ctx.fillStyle = '#111111';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Leaf outline and veins
  ctx.lineWidth = 9;
  ctx.beginPath();
  ctx.moveTo(120, 380);
  ctx.bezierCurveTo(140, 180, 330, 70, 520, 90);
  ctx.bezierCurveTo(500, 280, 330, 400, 120, 380);
  ctx.stroke();
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(120, 380);
  ctx.quadraticCurveTo(300, 260, 505, 105);
  ctx.stroke();
  ctx.lineWidth = 4;
  for (let i = 1; i <= 5; i++) {
    const t = i / 6;
    const x = 120 + (505 - 120) * t, y = 380 - (380 - 105) * t - 25 * Math.sin(Math.PI * t);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x - 10, y - 50, x - 30, y - 80 + i * 4);
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + 40, y + 10, x + 60, y + 50 - i * 6);
    ctx.stroke();
  }
  // Ink drops
  for (const [x, y, r] of [[560, 370, 16], [590, 330, 8], [80, 120, 11]]) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/** A busy emblem: thin rules, small dots, a sawtooth ring, stars, petals and small text. */
function emblem(): HTMLCanvasElement {
  const [c, ctx] = canvas(800, 800);
  const cx = 400, cy = 400;
  ctx.fillStyle = '#fbf6ec';
  ctx.fillRect(0, 0, 800, 800);
  const disc = (r: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  disc(360, '#14453d');
  disc(352, '#fbf6ec');
  disc(344, '#14453d');
  // Rim of small dots
  ctx.fillStyle = '#e9c46a';
  for (let i = 0; i < 60; i++) {
    const a = (Math.PI * 2 * i) / 60;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * 326, cy + Math.sin(a) * 326, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  disc(306, '#fbf6ec');
  // Sawtooth ring
  ctx.fillStyle = '#e76f51';
  ctx.beginPath();
  for (let i = 0; i <= 96; i++) {
    const a = (Math.PI * 2 * i) / 96;
    const r = i % 2 ? 300 : 282;
    ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
  disc(276, '#fbf6ec');
  // Hairline rules
  ctx.strokeStyle = '#14453d';
  for (const [r, lw] of [[268, 1.5], [262, 1], [200, 2]] as const) {
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Ring of small stars
  ctx.fillStyle = '#264653';
  for (let i = 0; i < 16; i++) {
    const a = (Math.PI * 2 * i) / 16;
    star(ctx, cx + Math.cos(a) * 232, cy + Math.sin(a) * 232, 9, 3.8);
    ctx.fill();
  }
  // Petals in two colours
  for (let i = 0; i < 12; i++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((Math.PI * 2 * i) / 12);
    ctx.fillStyle = i % 2 ? '#2a9d8f' : '#f4a261';
    ctx.beginPath();
    ctx.ellipse(0, -110, 26, 70, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  disc(52, '#e76f51');
  disc(30, '#fbf6ec');
  disc(18, '#264653');
  // Text, small and medium (the title sits on a banner so it reads)
  ctx.fillStyle = '#14453d';
  ctx.beginPath();
  ctx.roundRect(cx - 132, 186, 264, 40, 8);
  ctx.fill();
  ctx.fillStyle = '#fbf6ec';
  ctx.textAlign = 'center';
  ctx.font = '700 30px Georgia, "Times New Roman", serif';
  ctx.fillText('HANDCRAFTED', cx, 217);
  ctx.fillStyle = '#14453d';
  ctx.font = '600 15px system-ui, -apple-system, Segoe UI, sans-serif';
  ctx.fillText('EST. 2026 · SMALL BATCH · NO. 07', cx, 612);
  return c;
}

export const EXAMPLES: Example[] = [
  { id: 'badge', label: 'Badge logo', draw: badge },
  { id: 'emblem', label: 'Detailed emblem', draw: emblem },
  { id: 'landscape', label: 'Sunset poster', draw: landscape },
  { id: 'sprite', label: 'Pixel sprite', draw: sprite },
  { id: 'ink', label: 'Ink drawing', draw: ink },
];
