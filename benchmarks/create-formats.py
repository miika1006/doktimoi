"""Synthetic extraction fixtures. Dev-only dependencies: Pillow and reportlab."""
from pathlib import Path
from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

root = Path(__file__).resolve().parents[1] / 'examples/formats'
root.mkdir(exist_ok=True)
fonts = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
font_path = next((f for f in fonts if Path(f).exists()), None)
if not font_path:
    raise RuntimeError('Install Arial or DejaVu Sans to regenerate OCR fixtures')
image = Image.new('RGB', (1400, 600), 'white')
draw = ImageDraw.Draw(image)
font = ImageFont.truetype(font_path, 45)
for y, line in enumerate(['APPROVAL PROCESS', 'Image-only approval cap: 8400 EUR.', 'Hylkaaminen vaatii perustelun.', 'Do not approve your own request.']):
    draw.text((55, 65 + y * 100), line, font=font, fill='black')
image.save(root / 'approval.png')
png = (root / 'approval.png').read_bytes()

pdf = canvas.Canvas(str(root / 'guide.pdf'))
pdf.setFont('Helvetica', 14)
pdf.drawString(45, 780, 'Native PDF text: exports expire after 17 days.')
pdf.drawString(45, 750, 'This is a synthetic fixture, not a product promise.')
pdf.showPage()
pdf.setFont('Helvetica', 14)
pdf.drawString(45, 780, 'A page with native text and an embedded process image:')
pdf.drawImage(ImageReader(BytesIO(png)), 40, 470, width=510, height=219)
pdf.showPage()
pdf.save()

body = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
<w:p><w:r><w:t>Native Word rule: a manager must approve the request.</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="5486400" cy="2350000"/><wp:docPr id="1" name="Process image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="approval.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="5486400" cy="2350000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:p><w:r><w:t>Image 1 contains the approval cap and a restriction.</w:t></w:r></w:p>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>'''
with ZipFile(root / 'image-policy.docx', 'w', ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr('word/document.xml', body)
    z.writestr('word/_rels/document.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/approval.png"/></Relationships>')
    z.writestr('word/media/approval.png', png)
print(root)
