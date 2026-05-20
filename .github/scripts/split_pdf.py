"""
split_pdf.py — Monitorea carpeta Drive, separa PDF de facturas y sube ZIP.

Variables de entorno requeridas:
  GOOGLE_SERVICE_ACCOUNT  — JSON completo de la Service Account
  DRIVE_FOLDER_ID         — ID de la carpeta "Facturación Mensual"
"""

import os, io, re, json, zipfile, sys
from pathlib import Path
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload, MediaIoBaseUpload
from pypdf import PdfReader, PdfWriter

# ── Config ───────────────────────────────────────────────────────────────────
SA_JSON       = os.environ["GOOGLE_SERVICE_ACCOUNT"]
FOLDER_ID     = os.environ["DRIVE_FOLDER_ID"]
SCOPES        = ["https://www.googleapis.com/auth/drive"]
PROCESSED_TAG = "pat_procesado"   # Propiedad custom que marcamos en el PDF ya procesado

COD_MAP = {
    "5-A":"5A","5A":"5A","4-A":"4A","4A":"4A",
    "A-1":"A1","A1":"A1","A-2":"A2","A2":"A2",
    "B":"B","D-2":"D2","D2":"D2","D-3":"D3","D3":"D3",
}

# ── Drive client ─────────────────────────────────────────────────────────────
def get_drive():
    creds = service_account.Credentials.from_service_account_info(
        json.loads(SA_JSON), scopes=SCOPES
    )
    return build("drive", "v3", credentials=creds, cache_discovery=False)

# ── Listar PDFs en la carpeta que NO han sido procesados ─────────────────────
def list_pending_pdfs(drive):
    q = f"'{FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false"
    result = drive.files().list(
        q=q,
        fields="files(id,name,properties)",
        pageSize=20
    ).execute()
    files = result.get("files", [])
    # Filtrar los que ya tienen la propiedad "pat_procesado"
    pending = [f for f in files if not f.get("properties", {}).get(PROCESSED_TAG)]
    return pending

# ── Descargar archivo desde Drive ────────────────────────────────────────────
def download_file(drive, file_id):
    request = drive.files().get_media(fileId=file_id)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    buf.seek(0)
    return buf.read()

# ── Detectar COD y número de factura en texto ─────────────────────────────────
def detect_cod(text):
    m = re.search(r"COD:\s*([A-D0-9][-A-D0-9]*)", text)
    if not m:
        return None
    raw = m.group(1).strip().rstrip("-").upper()
    return COD_MAP.get(raw)

def detect_nro(text):
    m = re.search(r"N[º°]\s*(\d+)", text)
    return m.group(1) if m else None

# ── Detectar período desde nombre del archivo ────────────────────────────────
# Ej: "Facturación Pisa Mayo 2026.pdf" → "2026-05"
MESES = {"enero":"01","febrero":"02","marzo":"03","abril":"04","mayo":"05",
          "junio":"06","julio":"07","agosto":"08","septiembre":"09",
          "octubre":"10","noviembre":"11","diciembre":"12"}

def detect_periodo(filename):
    fn = filename.lower()
    for mes_nombre, mes_num in MESES.items():
        if mes_nombre in fn:
            # Buscar año
            year_m = re.search(r"(20\d{2})", filename)
            year = year_m.group(1) if year_m else "2026"
            return f"{year}-{mes_num}"
    # Fallback: usar fecha actual
    from datetime import datetime
    now = datetime.now()
    return f"{now.year}-{now.month:02d}"

# ── Subir ZIP a Drive ─────────────────────────────────────────────────────────
def upload_zip(drive, zip_name, zip_bytes, folder_id):
    meta = {"name": zip_name, "parents": [folder_id]}
    media = MediaIoBaseUpload(
        io.BytesIO(zip_bytes),
        mimetype="application/zip",
        resumable=False
    )
    file = drive.files().create(body=meta, media_body=media, fields="id,name").execute()
    return file["id"]

# ── Marcar PDF como procesado (propiedad custom en Drive) ─────────────────────
def mark_processed(drive, file_id, zip_name):
    drive.files().update(
        fileId=file_id,
        body={"properties": {PROCESSED_TAG: zip_name}}
    ).execute()

# ── Procesar un PDF ───────────────────────────────────────────────────────────
def process_pdf(drive, file_info):
    file_id   = file_info["id"]
    file_name = file_info["name"]
    periodo   = detect_periodo(file_name)

    print(f"\n{'='*60}")
    print(f"Procesando: {file_name}")
    print(f"Período detectado: {periodo}")

    # Descargar
    print("Descargando...")
    pdf_bytes = download_file(drive, file_id)
    print(f"  {len(pdf_bytes):,} bytes")

    # Leer con pypdf
    reader = PdfReader(io.BytesIO(pdf_bytes))
    total_pages = len(reader.pages)
    print(f"  {total_pages} páginas")

    # Separar páginas
    zip_buf   = io.BytesIO()
    sin_cod   = []
    breakdown = {}

    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            cod  = detect_cod(text)
            nro  = detect_nro(text)

            if not cod:
                sin_cod.append(i + 1)
                print(f"  Pág {i+1}: ⚠ sin COD")
                # Guardar en carpeta sin_cod para revisión
                fname = f"p{i+1}.pdf"
                writer = PdfWriter()
                writer.add_page(page)
                buf = io.BytesIO()
                writer.write(buf)
                zf.writestr(f"{periodo}/sin_cod/{fname}", buf.getvalue())
                continue

            fname = f"F-{nro}.pdf" if nro else f"F-p{i+1}.pdf"
            path  = f"{periodo}/{cod}/{fname}"

            writer = PdfWriter()
            writer.add_page(page)
            buf = io.BytesIO()
            writer.write(buf)
            zf.writestr(path, buf.getvalue())

            breakdown[cod] = breakdown.get(cod, 0) + 1
            print(f"  Pág {i+1}: {cod} → {fname}")

        # Log de resumen dentro del ZIP
        summary_lines = [f"Período: {periodo}", f"Total páginas: {total_pages}",
                         f"Procesadas: {sum(breakdown.values())}", f"Sin COD: {len(sin_cod)}", ""]
        for sitio, cnt in sorted(breakdown.items()):
            summary_lines.append(f"  {sitio}: {cnt} facturas")
        if sin_cod:
            summary_lines.append(f"\nSin COD (páginas): {sin_cod}")
        zf.writestr(f"{periodo}/resumen.txt", "\n".join(summary_lines))

    zip_data = zip_buf.getvalue()
    zip_name = f"{periodo}.zip"

    print(f"\nResumen:")
    for sitio, cnt in sorted(breakdown.items()):
        print(f"  {sitio}: {cnt} facturas")
    if sin_cod:
        print(f"  Sin COD: páginas {sin_cod}")
    print(f"ZIP: {len(zip_data):,} bytes → {zip_name}")

    # Subir ZIP
    print("Subiendo ZIP a Drive...")
    zip_id = upload_zip(drive, zip_name, zip_data, FOLDER_ID)
    print(f"  Subido: {zip_id}")
    print(f"  https://drive.google.com/file/d/{zip_id}/view")

    # Marcar PDF como procesado
    mark_processed(drive, file_id, zip_name)
    print(f"  PDF marcado como procesado ✓")

    return {"periodo": periodo, "zip_name": zip_name, "zip_id": zip_id,
            "total": sum(breakdown.values()), "sin_cod": len(sin_cod), "breakdown": breakdown}

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("Conectando a Google Drive...")
    drive = get_drive()

    print(f"Buscando PDFs pendientes en carpeta {FOLDER_ID}...")
    pending = list_pending_pdfs(drive)

    if not pending:
        print("No hay PDFs nuevos para procesar. ✓")
        return

    print(f"Encontrados {len(pending)} PDF(s) pendiente(s):")
    for f in pending:
        print(f"  - {f['name']} ({f['id']})")

    results = []
    errors  = []
    for file_info in pending:
        try:
            result = process_pdf(drive, file_info)
            results.append(result)
        except Exception as e:
            print(f"\n✗ Error procesando {file_info['name']}: {e}")
            errors.append({"file": file_info["name"], "error": str(e)})

    print(f"\n{'='*60}")
    print(f"Completado: {len(results)} procesados, {len(errors)} errores")
    if errors:
        for e in errors:
            print(f"  ✗ {e['file']}: {e['error']}")
        sys.exit(1)

if __name__ == "__main__":
    main()
