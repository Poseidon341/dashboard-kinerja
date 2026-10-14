// Data metrik utama
export const totals = {
  dpk: 13400000000000,      // 13,40 T
  tabungan: 5020000000000,  // 5,02 T
  giro: 4580000000000,      // 4,58 T
  deposito: 3800000000000,  // 3,80 T
};

// Fungsi pembuat data grafik (Dummy 31 Hari)
export const generateChartData = (baseVal: number) => {
  const data = [];
  for (let i = 1; i <= 31; i++) {
    data.push({
      day: i,
      // Garis abu-abu putus-putus (Dec 25)
      dec25: baseVal * 0.85 + (i * 0.02 * baseVal) + (Math.random() * 0.5),
      // Garis Biru Muda (Jun 26)
      jun26: baseVal * 0.90 + (i * 0.025 * baseVal) + (Math.random() * 0.6),
      // Garis Hijau (Jul 26)
      jul26: baseVal * 0.95 + (i * 0.03 * baseVal) + (Math.random() * 0.7),
      // Garis Oranye/Merah (Aug 26) - Misal baru sampai tanggal 30
      aug26: i <= 30 ? baseVal * 0.92 + (i * 0.028 * baseVal) + (Math.random() * 0.8) : null,
    });
  }
  return data;
};

// Data untuk 4 Grafik
export const chartDataTabungan = generateChartData(32);
export const chartDataGiro = generateChartData(6.5);
export const chartDataDeposito = generateChartData(8.2);
export const chartDataDPK = generateChartData(48);