const pdfParse = require('pdf-parse');
const fs = require('fs');
const buffer = fs.readFileSync('/Users/abelespinozaviguera/Downloads/$value.pdf');
pdfParse(buffer).then(data => {
  const lineas = data.text.split('\n').map(l => l.trim()).filter(l => l);
  const diasOrden = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
  const bloques = [];

  for (let i = 0; i < lineas.length; i++) {
    const l = lineas[i];

    // Detectar línea de módulo: empieza con número 1-10 seguido de "Sala:"
    const modMatch = l.match(/^(\d+)(Sala:.+)$/);
    if (!modMatch) continue;

    const modNum = parseInt(modMatch[1]);
    const salasStr = modMatch[2];

    // Extraer salas: "Sala:TRSR-602Sala:TRAN-604..." -> ["TRSR-602","TRAN-604",...]
    const salas = salasStr.split('Sala:').filter(s => s).map(s => s.trim());

    // Línea anterior tiene los ramos concatenados (puede ser 1 o 2 líneas antes)
    // Buscar hacia atrás la línea de ramos
    let ramosStr = '';
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const prev = lineas[j];
      // Es línea de ramos si está en mayúsculas y no es nombre de alumno/fecha
      if (prev === prev.toUpperCase() && prev.length > 3 && !prev.match(/^\d/) && !prev.includes('MOD') && !prev.includes('ALUMNO') && !prev.includes('MATRÍCULA') && !prev.includes('HORARIO')) {
        ramosStr = prev + (ramosStr ? ' ' + ramosStr : '');
      } else if (prev.match(/[a-z]/) && prev.length > 5) {
        // nombre de profesor, ignorar
        break;
      }
    }

    // Línea de horarios: siguiente línea después de "Horario:Horario:..."
    let horariosStr = '';
    for (let j = i + 1; j < Math.min(lineas.length, i + 4); j++) {
      if (lineas[j].match(/^Horario:/)) {
        horariosStr = lineas[j + 1] || '';
        break;
      }
    }

    // Extraer horarios: "08:00-09:1008:00-09:10..." -> ["08:00-09:10","08:00-09:10",...]
    const horarios = horariosStr.match(/\d{2}:\d{2}-\d{2}:\d{2}/g) || [];

    // Extraer ramos: separar por nombres conocidos de ramos
    // Los ramos están concatenados, usamos las salas como referencia de cantidad
    const numClases = salas.length;

    // Separar ramos concatenados usando mayúsculas y palabras clave
    // Estrategia: dividir por patrones de inicio de ramo conocidos
    const ramosRaw = ramosStr;
    
    console.log(`MOD ${modNum}: ramos="${ramosRaw}" salas=${JSON.stringify(salas)} horarios=${JSON.stringify(horarios)}`);
  }
});
