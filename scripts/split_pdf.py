"""
split_pdf.py — Separa PDF de facturas y guarda ZIP localmente.
El workflow de GitHub Actions lo sube como artefacto descargable.
"""

import os, io, re, json, zipfile, sys
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from pypdf import PdfReader, PdfWriter

SA_JSON   = os.environ["GOOGLE_SERVICE_ACCOUNT"]
FOLDER_ID = os.environ["DRIVE_FOLDER_ID"]
SCOPES    = ["https://www.googleapis.com/auth/drive.readonly"]
PROCESSED_TAG = "pat_procesado"

COD_MAP = {
    "5-A":"5A","5A":"5A","4-A":"4A","4A":"4A",
    "A-1":"A1","A1":"A1","A-2":"A2","A2":"A2",
    "B":"B","D-2":"D2","D2":"D2","D-3":"D3","D3":"D3",
}

MESES = {"enero":"01","febrero":"02","marzo":"03","abril":"04","mayo":"05",
         "junio":"06","julio":"07","agosto":"08","septiembre":"09",
         "octubre":"10","noviembre":"11","diciembre":"12"}

def get_drive():
    creds = service_account.Credentials.from_service_account_info(
        json.loads(SA_JSON), scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)

def list_pending(drive):
    q = f"'{FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false"
    res = drive.files().list(q=q, fields="files(id,name,properties)", pageSize=20).execute()
    return [f for f in res.get("files",[]) if not f.get("properties",{}).get(PROCESSED_TAG)]

def download(drive, fid):
    req = drive.files().get_media(fileId=fid)
    buf = io.BytesIO()
    dl = MediaIoBaseDownload(buf, req)
    done = False
    while not done: _, done = dl.next_chunk()
    buf.seek(0); return buf.read()

def detect_cod(text):
    m = re.search(r"COD:\s*([A-D0-9][-A-D0-9]*)", text)
    if not m: return None
    return COD_MAP.get(m.group(1).strip().rstrip("-").upper())

def detect_nro(text):
    m = re.search(r"N[º°]\s*(\d+)", text)
    return m.group(1) if m else None

def detect_periodo(name):
    nl = name.lower()
    for mes, num in MESES.items():
        if mes in nl:
            ym = re.search(r"(20\d{2})", name)
            return f"{ym.group(1) if ym else '2026'}-{num}"
    from datetime import datetime
    n = datetime.now()
    return f"{n.year}-{n.month:02d}"

def process(drive, fi):
    fid, fname = fi["id"], fi["name"]
    periodo = detect_periodo(fname)
    print(f"\nProcesando: {fname} → período {periodo}")

    pdf = download(drive, fid)
    reader = PdfReader(io.BytesIO(pdf))
    print(f"  {len(reader.pages)} páginas")

    zip_buf   = io.BytesIO()
    sin_cod   = []
    breakdown = {}

    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, page in enumerate(reader.pages):
            text = page.extract_text() or ""            
if i < 3:  # Solo primeras 3 páginas
    print(f"  DEBUG pág {i+1}: '{text[:200]}'")
            cod  = detect_cod(text)
            nro  = detect_nro(text)

            if not cod:
                sin_cod.append(i+1)
                writer = PdfWriter(); writer.add_page(page)
                buf = io.BytesIO(); writer.write(buf)
                zf.writestr(f"{periodo}/sin_cod/p{i+1}.pdf", buf.getvalue())
                continue

            fname_pdf = f"F-{nro}.pdf" if nro else f"F-p{i+1}.pdf"
            writer = PdfWriter(); writer.add_page(page)
            buf = io.BytesIO(); writer.write(buf)
            zf.writestr(f"{periodo}/{cod}/{fname_pdf}", buf.getvalue())
            breakdown[cod] = breakdown.get(cod,0)+1
            print(f"  Pág {i+1}: {cod} → {fname_pdf}")

        lines = [f"Período: {periodo}", f"Total: {len(reader.pages)} páginas",
                 f"Procesadas: {sum(breakdown.values())}", f"Sin COD: {len(sin_cod)}", ""]
        lines += [f"  {s}: {c}" for s,c in sorted(breakdown.items())]
        if sin_cod: lines.append(f"\nSin COD: páginas {sin_cod}")
        zf.writestr(f"{periodo}/resumen.txt", "\n".join(lines))

    print("\nResumen:")
    for s,c in sorted(breakdown.items()): print(f"  {s}: {c} facturas")
    if sin_cod: print(f"  Sin COD: {sin_cod}")

    # Guardar ZIP en carpeta output/ para que Actions lo suba como artefacto
    os.makedirs("output", exist_ok=True)
    zip_name = f"{periodo}.zip"
    zip_path = f"output/{zip_name}"
    with open(zip_path, "wb") as f: f.write(zip_buf.getvalue())
    print(f"ZIP guardado: {zip_path} ({os.path.getsize(zip_path):,} bytes)")

    return {"periodo":periodo,"zip":zip_name,"total":sum(breakdown.values()),"sin_cod":len(sin_cod)}

def main():
    drive = get_drive()
    pending = list_pending(drive)
    if not pending:
        print("No hay PDFs nuevos."); return

    print(f"{len(pending)} PDF(s) pendiente(s):")
    for f in pending: print(f"  - {f['name']}")

    errors = []
    for fi in pending:
        try: process(drive, fi)
        except Exception as e:
            print(f"✗ Error: {e}"); errors.append(str(e))

    if errors: sys.exit(1)

if __name__ == "__main__":
    main()
