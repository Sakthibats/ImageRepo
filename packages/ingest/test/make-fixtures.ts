import sharp from 'sharp';
const lib = process.argv[2];
const colors = ['#c0392b','#2980b9','#27ae60','#8e44ad','#d35400','#16a085'];
const plan: [string, number, number, number][] = [
  ['Goa 2023', 6, 4032, 3024],
  ['Kids Birthday', 4, 3024, 4032],   // portrait
  ['Trips/Kerala 2024/Day 1', 3, 4032, 3024],
];
let n = 0;
for (const [folder, count, w, h] of plan) {
  for (let i = 1; i <= count; i++) {
    const f = `${lib}/${folder}/IMG_2023121${(i%9)+1}_1430${String(i).padStart(2,'0')}.jpg`;
    await sharp({ create: { width: w, height: h, channels: 3, background: colors[n++ % colors.length] } })
      .jpeg({ quality: 88 }).toFile(f);
  }
}
console.log('fixture photos written');
