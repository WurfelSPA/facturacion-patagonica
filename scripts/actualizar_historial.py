#!/usr/bin/env python3
"""
actualizar_historial.py - Procesa ZIP de XMLs de Nubox y actualiza historial-excel-2026.json

Uso:
  python scripts/actualizar_historial.py <archivo_zip> [--mes "Junio 2026"] [--dry-run]
"""
import sys, os, re, json, zipfile, argparse, tempfile
import xml.etree.ElementTree as ET
from collections import defaultdict, Counter

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JSON_PATH = os.path.join(REPO_ROOT, "historial-excel-2026.json")
YEAR = "2026"
MESES_ES = {1:"Enero",2:"Febrero",3:"Marzo",4:"Abril",5:"Mayo",6:"Junio",
            7:"Julio",8:"Agosto",9:"Septiembre",10:"Octubre",11:"Noviembre",12:"Diciembre"}

def normalizar_codigo(cod):
    return re.sub(r"[-]", "", (cod or "").strip()).upper()

def clasificar_concepto(nombre_item):
    n = (nombre_item or "").lower()
    if "arriendo" in n:     return "arriendo", False
    if "habilitac" in n:    return "habilitacion", True
    if "serv. adm" in n or "serv adm" in n or "serv.adm" in n: return "servAdm", True
    if "serv. mant" in n or "serv mant" in n or "mantenimiento" in n: return "servMant", True
    if "contable" in n:     return "servContables", True
    if "asesoria" in n:     return "asesoria", True
    return None, True

def extraer_uf_desc(desc):
    if not desc: return None
    m = re.search(r"UF\s+([\d]+[,.]\d+)", desc.replace("\n", " "), re.IGNORECASE)
    return float(m.group(1).replace(",", ".")) if m else None

def parsear_xml(path):
    try:
        root = ET.parse(path).getroot()
    except Exception:
        return None
    tipo  = root.findtext(".//TipoDTE", "")
    folio = root.findtext(".//Folio", "")
    fecha = root.findtext(".//FchEmis", "")
    rut   = root.findtext(".//RUTRecep", "")
    razon = root.findtext(".//RznSocRecep", "")
    total_s = root.findtext(".//MntTotal", "0") or "0"
    total = int(total_s) if total_s.lstrip("-").isdigit() else 0
    if tipo not in ("33","34","61"): return None
    if tipo == "61" and total == 0:  return None

    detalles = {}
    for det in root.findall(".//Detalle"):
        cod    = det.findtext(".//VlrCodigo", "").strip()
        nombre = det.findtext("NmbItem", "").strip()
        qty_s  = det.findtext("QtyItem", "") or ""
        und    = det.findtext("UnmdItem", "") or ""
        desc   = det.findtext("DscItem", "") or ""
        key    = (cod, nombre)
        if key not in detalles:
            detalles[key] = {"uf": None}
        if und.upper() == "UF" and qty_s and detalles[key]["uf"] is None:
            try: detalles[key]["uf"] = float(qty_s.replace(",", "."))
            except Exception: pass
        if detalles[key]["uf"] is None:
            detalles[key]["uf"] = extraer_uf_desc(desc)

    return {"tipo":tipo,"folio":folio,"fecha":fecha,"rut":rut,"razon":razon,
            "total":total,"detalles":detalles}

def detectar_mes(facturas_por_rut):
    c = Counter()
    for lista in facturas_por_rut.values():
        for inv in lista:
            if inv["fecha"]:
                parts = inv["fecha"].split("-")
                if len(parts) >= 2:
                    try: c[int(parts[1])] += 1
                    except Exception: pass
    if not c: return None
    m = c.most_common(1)[0][0]
    return MESES_ES[m] + " " + YEAR

def construir_entradas_mes(facturas_por_rut):
    resultado = {}
    for rut, lista in facturas_por_rut.items():
        razon = lista[0]["razon"].strip().upper()
        if razon not in resultado:
            resultado[razon] = {}
        for inv in lista:
            folio = inv["folio"]
            nro   = "F-" + folio
            total_inv = inv["total"]
            concepto_key, va_default, site_key, uf_inv = None, True, "default", None
            for (cod, nombre), datos in inv["detalles"].items():
                c, d = clasificar_concepto(nombre)
                s    = normalizar_codigo(cod) if cod else ""
                if concepto_key is None:
                    concepto_key, va_default = c, d
                    site_key = s if s else "default"
                if uf_inv is None and datos["uf"] is not None:
                    uf_inv = datos["uf"]
            if va_default:
                bucket    = "default"
                entry_key = concepto_key if concepto_key else ("F" + folio)
            else:
                bucket    = site_key if site_key else "default"
                entry_key = concepto_key or ("F" + folio)
            if bucket not in resultado[razon]:
                resultado[razon][bucket] = {}
            if entry_key in resultado[razon][bucket]:
                entry_key = "F" + folio
            resultado[razon][bucket][entry_key] = {"nro":nro,"uf":uf_inv,"total":total_inv}
    return resultado

def mostrar_preview(mes_str, nuevo_mes, json_actual):
    existente = json_actual.get(YEAR, {}).get(mes_str, {})
    sep = "=" * 62
    print("")
    print(sep)
    print("  Mes: " + mes_str + " | Clientes detectados: " + str(len(nuevo_mes)))
    print(sep)
    for cliente, sitios in sorted(nuevo_mes.items()):
        flag = "  [NUEVO]" if cliente not in existente else ""
        print("")
        print("  " + cliente + flag)
        for site, conceptos in sorted(sitios.items()):
            for concepto, datos in sorted(conceptos.items()):
                uf_s = " | UF {:.2f}".format(datos["uf"]) if datos["uf"] else ""
                total_s = "{:,.0f}".format(datos["total"])
                print("    [" + site + "] " + concepto.ljust(16) + " " + datos["nro"].ljust(12) + uf_s + " | $" + total_s.rjust(14))
    solo_existentes = set(existente) - set(nuevo_mes)
    if solo_existentes:
        print("")
        print("  Info: Se conservan (no en este ZIP): " + ", ".join(sorted(solo_existentes)))

def main():
    parser = argparse.ArgumentParser(description="Actualiza historial-excel-2026.json desde ZIP de XMLs Nubox")
    parser.add_argument("zip_path", help="Ruta al archivo ZIP con XMLs de Nubox")
    parser.add_argument("--mes", default=None, help='Mes a procesar, e.g. "Junio 2026"')
    parser.add_argument("--dry-run", action="store_true", help="Solo mostrar preview, sin guardar")
    parser.add_argument("--json", default=JSON_PATH, help="Ruta al JSON de historial")
    args = parser.parse_args()

    if not os.path.exists(args.zip_path):
        print("ERROR: " + args.zip_path + " no encontrado")
        sys.exit(1)

    print("")
    print("Leyendo " + os.path.basename(args.zip_path) + "...")
    facturas_por_rut = defaultdict(list)
    ignoradas = 0
    with tempfile.TemporaryDirectory() as tmpdir:
        with zipfile.ZipFile(args.zip_path) as z:
            z.extractall(tmpdir)
        xmls = [f for f in os.listdir(tmpdir) if f.endswith(".xml")]
        print("  XMLs encontrados: " + str(len(xmls)))
        for fname in sorted(xmls):
            inv = parsear_xml(os.path.join(tmpdir, fname))
            if inv and inv["rut"] and inv["total"] != 0:
                facturas_por_rut[inv["rut"]].append(inv)
            else:
                ignoradas += 1

    total_f = sum(len(v) for v in facturas_por_rut.values())
    print("  Validas: " + str(total_f) + " | Clientes: " + str(len(facturas_por_rut)) + " | Ignoradas: " + str(ignoradas))

    mes_str = args.mes or detectar_mes(facturas_por_rut)
    if not mes_str:
        print("ERROR: no se pudo detectar el mes. Usa --mes 'Mes YYYY'")
        sys.exit(1)

    nuevo_mes = construir_entradas_mes(facturas_por_rut)

    with open(args.json, encoding="utf-8") as f:
        json_actual = json.load(f)

    mostrar_preview(mes_str, nuevo_mes, json_actual)

    if args.dry_run:
        print("")
        print("  [DRY-RUN] Sin cambios guardados.")
        return

    print("")
    respuesta = input("Actualizar " + mes_str + "? (s/n): ").strip().lower()
    if respuesta not in ("s", "si", "y", "yes"):
        print("Cancelado.")
        return

    if YEAR not in json_actual:
        json_actual[YEAR] = {}
    if mes_str not in json_actual[YEAR]:
        json_actual[YEAR][mes_str] = {}
    mes_act = json_actual[YEAR][mes_str]
    for cliente, sitios in nuevo_mes.items():
        if cliente not in mes_act:
            mes_act[cliente] = {}
        for site, conceptos in sitios.items():
            if site not in mes_act[cliente]:
                mes_act[cliente][site] = {}
            for concepto, datos in conceptos.items():
                mes_act[cliente][site][concepto] = datos

    with open(args.json, "w", encoding="utf-8") as f:
        json.dump(json_actual, f, indent=2, ensure_ascii=False)

    print("")
    print("Actualizado: " + mes_str)
    print("  Siguiente paso: git add historial-excel-2026.json && git commit -m 'data: " + mes_str + "' && git push")

if __name__ == "__main__":
    main()
