"""The ibon print-specification model and the folder/file name rules."""

import pytest


class TestPrintSpec:
    @pytest.mark.parametrize(
        "select_type,expected",
        [
            ("FA4CN1", "A4、彩色、單面列印、一般用紙"),
            ("FA3BS2", "A3、黑白、雙面列印、特殊用紙"),
            ("F4X6N1", "4x6、彩色、單面列印、一般用紙"),
            ("F4X6S1", "4x6貼紙、彩色、單面列印、一般用紙"),
        ],
    )
    def test_describes_known_codes(self, ibon, select_type, expected):
        assert ibon.print_spec(select_type) == expected

    def test_falls_back_for_anything_unrecognised(self, ibon):
        """The default `FNOMAL` from migration 0003 lands here."""

        assert ibon.print_spec("FNOMAL") == "未預選規格"
        assert ibon.print_spec("") == "未預選規格"


class TestValidateSelectType:
    def test_accepts_every_preset(self, ibon):
        for select_type in ibon.PRESET_PRINT_SELECT_TYPES:
            assert ibon.validate_select_type(select_type) == select_type

    def test_covers_the_combinations_the_ui_offers(self, ibon):
        # Two paper sizes, two colour modes, two paper kinds, two side modes,
        # plus the two photo-paper codes.
        assert len(ibon.PRESET_PRINT_SELECT_TYPES) == 2 * 2 * 2 * 2 + 2

    @pytest.mark.parametrize("value", ["", "FA4CN3", "FA5CN1", "fa4cn1", "DROP TABLE"])
    def test_rejects_anything_else(self, ibon, value):
        with pytest.raises(ValueError):
            ibon.validate_select_type(value)

    def test_every_preset_has_a_description(self, ibon):
        """A code the admin can pick must never render as 未預選規格."""

        for select_type in ibon.PRESET_PRINT_SELECT_TYPES:
            assert ibon.print_spec(select_type) != "未預選規格"


class TestNameValidation:
    @pytest.mark.parametrize("folder", ["20260721_soda", "a", "A-1_2", "0"])
    def test_accepts_reasonable_folder_ids(self, common, folder):
        assert common.validate_folder(folder) == folder

    @pytest.mark.parametrize("folder", ["", "_leading", "-leading", "has space", "a/b", "a" * 129])
    def test_rejects_bad_folder_ids(self, common, folder):
        with pytest.raises(ValueError):
            common.validate_folder(folder)

    @pytest.mark.parametrize("name", ["soda (1).jpg", "a.jpeg", "b.PNG", "c.bmp", "d.gif"])
    def test_accepts_supported_images(self, common, name):
        assert common.validate_file_name(name) == name

    @pytest.mark.parametrize("name", ["notes.txt", "a.jpg.exe", "../escape.jpg", "dir/a.jpg", "no-extension"])
    def test_rejects_everything_else(self, common, name):
        with pytest.raises(ValueError):
            common.validate_file_name(name)

    def test_the_avatar_prefix_is_not_a_valid_folder(self, common, bio_link):
        """Avatars share the bucket, so /images/ must not be able to reach them."""

        with pytest.raises(ValueError):
            common.validate_folder(bio_link.AVATAR_PREFIX)
