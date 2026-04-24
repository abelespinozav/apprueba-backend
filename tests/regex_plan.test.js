const regex = /--- Contenido de ([^-]+) ---\n\([^)]*(?:No se pudo|Formato no soportado|Formato Word)[^)]*\)/g;

const casos = [
  {
    nombre: 'Caso 1: .doc binario',
    input: '--- Contenido de apuntes.doc ---\n(Formato Word 97-2003 no soportado directamente)\n\n--- Contenido de bueno.pdf ---\nContenido real aqui',
    esperado: 'apuntes.doc detectado como error'
  },
  {
    nombre: 'Caso 2: multiples errores',
    input: '--- Contenido de a.doc ---\n(Formato Word antiguo)\n--- Contenido de b.xyz ---\n(Formato no soportado)',
    esperado: 'ambos detectados'
  },
  {
    nombre: 'Caso 3: archivo con parentesis en nombre (edge case)',
    input: '--- Contenido de reporte (final).pdf ---\nContenido real',
    esperado: 'NO deberia matchear'
  },
  {
    nombre: 'Caso 4: solo material bueno',
    input: '--- Contenido de apuntes.pdf ---\nContenido academico real y extenso sobre logica matematica',
    esperado: 'NO deberia matchear'
  }
];

for (const caso of casos) {
  const matches = [...caso.input.matchAll(regex)];
  console.log(`\n${caso.nombre}:`);
  console.log(`  Esperado: ${caso.esperado}`);
  console.log(`  Matches encontrados: ${matches.length}`);
  matches.forEach(m => console.log(`    → Archivo: "${m[1].trim()}"`));
}
