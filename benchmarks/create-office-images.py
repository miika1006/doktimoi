"""Dev-only fixtures: pip install python-pptx openpyxl Pillow. No Python runtime dependency."""
from pathlib import Path
from pptx import Presentation
from pptx.util import Inches
from openpyxl import Workbook
from openpyxl.drawing.image import Image

root = Path(__file__).resolve().parents[1]
dest = root / 'examples/extended'
dest.mkdir(exist_ok=True)
image = root / 'examples/formats/approval.png'

workbook = Workbook()
sheet = workbook.active
sheet.title = 'Approval Policy'
sheet.append(['Rule', 'Value'])
sheet.append(['NATIVE_XLSX_MARKER', 'Manager approval required'])
sheet.add_image(Image(image), 'D5')
workbook.save(dest / 'image-policy.xlsx')

presentation = Presentation()
slide = presentation.slides.add_slide(presentation.slide_layouts[5])
slide.shapes.title.text = 'NATIVE_PPTX_MARKER: escalation within 72 hours'
slide.notes_slide.notes_text_frame.text = 'SPEAKER_NOTES_MARKER: proposal only, not yet shipped.'
table = slide.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(7), Inches(1.5)).table
table.cell(0, 0).text = 'Product'
table.cell(0, 1).text = 'Annual EUR'
table.cell(1, 0).text = 'Enterprise'
table.cell(1, 1).text = '24000'
slide = presentation.slides.add_slide(presentation.slide_layouts[5])
slide.shapes.title.text = 'Image-only approval rule'
slide.shapes.add_picture(str(image), Inches(0.5), Inches(1.5), width=Inches(9))
# XML part names remain slide1/slide2; displayed order is reversed.
ids = presentation.slides._sldIdLst
ids.insert(0, ids[-1])
presentation.save(dest / 'image-policy.pptx')
