// ═══════════════════════════════════════════════════════════════════
//  PATAGÓNICA — Agregar columnas del mes siguiente en Planilla Flujo
//  Instalación: Tools > Script editor → pegar este código → Save
//  Trigger automático: ejecutar installTrigger() una sola vez
// ═══════════════════════════════════════════════════════════════════

var SHEET_NAME = 'Flujo';

// ── Función principal ────────────────────────────────────────────────
function addNextMonthColumns() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ws = ss.getSheetByName(SHEET_NAME);

  if (!ws) {
    SpreadsheetApp.getUi().alert('❌ No se encontró la hoja "' + SHEET_NAME + '"');
    return;
  }

  var lastCol = ws.getLastColumn();
  var lastRow = ws.getLastRow();

  // 1. Encontrar la última columna con fecha en fila 3
  var prevMesCol = -1;
  for (var col = lastCol; col >= 1; col--) {
    var val = ws.getRange(3, col).getValue();
    if (val instanceof Date) {
      prevMesCol = col;
      break;
    }
  }

  if (prevMesCol === -1) {
    SpreadsheetApp.getUi().alert('❌ No se encontró ninguna columna de mes (fecha) en fila 3.');
    return;
  }

  var prevGcCol  = prevMesCol + 1;
  var newMesCol  = lastCol + 1;
  var newGcCol   = newMesCol + 1;

  // 2. Calcular la fecha del mes siguiente
  var prevDate  = ws.getRange(3, prevMesCol).getValue();
  var nextDate  = new Date(prevDate.getFullYear(), prevDate.getMonth() + 1, 1);
  var nextLabel = Utilities.formatDate(nextDate, Session.getScriptTimeZone(), 'MMM-yy').toLowerCase();

  // Verificar que no se hayan agregado ya (evitar duplicados)
  var checkVal = ws.getRange(3, newMesCol).getValue();
  if (checkVal instanceof Date && checkVal.getMonth() === nextDate.getMonth()) {
    SpreadsheetApp.getUi().alert('⚠️ Las columnas de ' + nextLabel + ' ya existen.');
    return;
  }

  var dataStartRow = 5;
  var numDataRows  = lastRow - dataStartRow + 1;

  // 3. Copiar formato del bloque anterior al nuevo bloque
  ws.getRange(3, prevMesCol, numDataRows + 2, 5)
    .copyTo(
      ws.getRange(3, newMesCol, numDataRows + 2, 5),
      SpreadsheetApp.CopyPasteType.PASTE_FORMAT,
      false
    );

  // 4. Escribir encabezados fila 3
  ws.getRange(3, newMesCol    ).setValue(nextDate);
  ws.getRange(3, newGcCol     ).setValue('GC');
  ws.getRange(3, newMesCol + 2).setValue('Comentarios');
  ws.getRange(3, newMesCol + 3).setValue('Correo Enviado');
  ws.getRange(3, newMesCol + 4).setValue('Pagado');

  // 5. Escribir encabezados fila 4
  ws.getRange(4, newMesCol    ).setValue('U.F.');
  ws.getRange(4, newGcCol     ).setValue('U.F.');
  ws.getRange(4, newMesCol + 2).setValue('');
  ws.getRange(4, newMesCol + 3).setValue('');
  ws.getRange(4, newMesCol + 4).setValue('');

  // 6. Copiar valores de UF (columna mes anterior → nueva columna mes)
  if (numDataRows > 0) {
    var prevMesValues = ws.getRange(dataStartRow, prevMesCol, numDataRows, 1).getValues();
    ws.getRange(dataStartRow, newMesCol, numDataRows, 1).setValues(prevMesValues);
  }

  // 7. Copiar columna GC: formulas adaptadas + valores
  var prevMesLetter = colToLetter(prevMesCol);
  var newMesLetter  = colToLetter(newMesCol);

  var gcFormulas = ws.getRange(dataStartRow, prevGcCol, numDataRows, 1).getFormulas();
  var gcValues   = ws.getRange(dataStartRow, prevGcCol, numDataRows, 1).getValues();

  var newGcValues   = [];
  var formulaCells  = [];  // {idx, formula}

  for (var i = 0; i < numDataRows; i++) {
    var formula = gcFormulas[i][0];
    if (formula) {
      // Reemplazar referencias a la columna mes anterior → nueva columna mes
      // Cubre: HB15, $HB15, HB$15, $HB$15, HB:HB
      var updated = formula.split(prevMesLetter).join(newMesLetter);
      formulaCells.push({ row: dataStartRow + i, formula: updated });
      newGcValues.push(['']);  // placeholder; se sobreescribirá con setFormula
    } else {
      var v = gcValues[i][0];
      newGcValues.push([v !== null && v !== undefined ? v : '']);
    }
  }

  // Escribir valores en bloque
  ws.getRange(dataStartRow, newGcCol, numDataRows, 1).setValues(newGcValues);

  // Escribir fórmulas una a una (solo las celdas que las tienen)
  for (var j = 0; j < formulaCells.length; j++) {
    ws.getRange(formulaCells[j].row, newGcCol).setFormula(formulaCells[j].formula);
  }

  // 8. Formatear fecha en encabezado (dd-mmm-yy)
  ws.getRange(3, newMesCol).setNumberFormat('mmm-yy');

  SpreadsheetApp.getUi().alert(
    '✅ Columnas de ' + nextLabel.toUpperCase() + ' agregadas correctamente.\n\n' +
    'Columnas ' + colToLetter(newMesCol) + ' a ' + colToLetter(newMesCol + 4) + '\n' +
    'Fórmulas GC adaptadas: ' + formulaCells.length + '\n' +
    'Filas de datos: ' + numDataRows
  );
}

// ── Instalar trigger automático (ejecutar solo una vez) ──────────────
function installTrigger() {
  // Eliminar triggers previos de esta función para evitar duplicados
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'addNextMonthColumns') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Crear trigger: día 25 de cada mes, entre 8:00 y 9:00 AM
  ScriptApp.newTrigger('addNextMonthColumns')
    .timeBased()
    .onMonthDay(25)
    .atHour(8)
    .create();

  SpreadsheetApp.getUi().alert(
    '✅ Trigger instalado.\n\nLa planilla se actualizará automáticamente\nel día 25 de cada mes a las 8:00 AM.'
  );
}

// ── Menú en la planilla ──────────────────────────────────────────────
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📅 Facturación')
    .addItem('➕ Agregar mes siguiente', 'addNextMonthColumns')
    .addSeparator()
    .addItem('⚙️ Instalar trigger automático (día 25)', 'installTrigger')
    .addToUi();
}

// ── Helper: número de columna → letra(s) ────────────────────────────
function colToLetter(col) {
  var letter = '';
  while (col > 0) {
    var rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}
