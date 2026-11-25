"""Run with a Python environment containing plotly==6.6.0, pandas, matplotlib."""
import json
from pathlib import Path
import unittest

import plotly.express as px
import plotly.graph_objects as go
import plotly.io as pio
import matplotlib.pyplot as plt


# Exercise the actual bridge installed into Pyodide, not a copy of its logic.
worker = (Path(__file__).resolve().parents[1] / "app/python-worker.ts").read_text()
setup = worker.split("const FOLIO_PYTHON_SETUP = String.raw`", 1)[1].split("`;", 1)[0]
bridge = {}
exec(setup, bridge)


class PythonOutputTests(unittest.TestCase):
    def setUp(self):
        bridge["_folio_prepare"]()
        bridge["_folio_run_start"]()
        bridge["_folio_begin"]("{}")

    def plots(self):
        return json.loads(bridge["_folio_plotly_json"]())

    def test_show_preserves_data_layout_and_config(self):
        go.Figure(go.Bar(x=["a", "b"], y=[2, 5]), layout={"title": "Bars"}).show(
            config={"displayModeBar": False}
        )
        plot, = self.plots()
        self.assertEqual(plot["data"][0]["y"], [2, 5])
        self.assertEqual(plot["layout"]["title"]["text"], "Bars")
        self.assertFalse(plot["config"]["displayModeBar"])

    def test_last_expression_and_explicit_show_do_not_duplicate(self):
        figure = go.Figure(go.Scatter(y=[1, 2]))
        figure.show()
        self.assertTrue(bridge["_folio_capture_result"](figure))
        self.assertEqual(len(self.plots()), 1)
        second = go.Figure(go.Bar(y=[3]))
        self.assertTrue(bridge["_folio_capture_result"](second))
        self.assertEqual(len(self.plots()), 2)
        self.assertFalse(bridge["_folio_capture_result"](42))

    def test_io_show_supports_dictionary_and_renderer_argument(self):
        pio.show({"data": [{"type": "scatter", "y": [4]}]}, renderer="browser")
        self.assertEqual(self.plots()[0]["data"][0]["y"], [4])

    def test_express_animation_preserves_frames_and_numpy_data(self):
        figure = px.scatter(x=[1, 2, 3, 4], y=[4, 3, 2, 1], animation_frame=[0, 0, 1, 1])
        figure.show()
        plot, = self.plots()
        self.assertEqual(len(plot["frames"]), 2)
        self.assertEqual(plot["data"][0]["x"]["dtype"], "i1")
        self.assertIn("bdata", plot["data"][0]["x"])

    def test_reruns_clear_figures_and_controls_can_rebuild_them(self):
        bridge["_folio_begin"]('{"height": 7}')
        value = bridge["_folio"].slider("height", 0, 10)
        go.Figure(go.Bar(y=[value])).show()
        self.assertEqual(self.plots()[0]["data"][0]["y"], [7])
        bridge["_folio_run_start"]()
        self.assertEqual(self.plots(), [])

    def test_matplotlib_and_plotly_can_share_a_block(self):
        plt.plot([1, 2], [3, 4])
        go.Figure(go.Scatter(y=[5, 6])).show()
        capture = json.loads(bridge["_folio_capture_all_json"]())
        self.assertEqual(len(capture["images"]), 1)
        self.assertTrue(capture["images"][0].startswith("iVBOR"))
        self.assertEqual(len(self.plots()), 1)

    def test_import_detection_handles_aliases_multiline_and_false_positives(self):
        detects = bridge["_folio_imports_plotly"]
        for code in ("import plotly.express as px", "import os, plotly", "from plotly import (\n graph_objects as go,\n)"):
            self.assertTrue(detects(code), code)
        for code in ('# import plotly\nprint("plotly")', 'text = "import plotly"', "import plotly_other", "invalid python ("):
            self.assertFalse(detects(code), code)


if __name__ == "__main__":
    unittest.main()
