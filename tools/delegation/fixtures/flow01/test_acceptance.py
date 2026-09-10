import unittest

from scheduler import completed, mark_done


class Acceptance(unittest.TestCase):
    def test_batch_does_not_complete_dependency(self):
        completed.clear()
        mark_done("child", required=("parent",))
        self.assertNotIn("child", completed)

    def test_completes_when_requirements_met(self):
        completed.clear()
        mark_done("parent")
        mark_done("child", required=("parent",))
        self.assertIn("parent", completed)
        self.assertIn("child", completed)
