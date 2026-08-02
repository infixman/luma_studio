"""Reading the request body, more than once.

A body is a stream and a stream is read once. The runtime says so plainly the
second time:

    OSError: Body already used

Which is what saving a course did — `_course_fields(await ctx.json_body())`
and then `_course_display_fields(await ctx.json_body())`, two lines apart. It
looked like reading a dict twice, because that is what `json_body` looks like.

So `Ctx` remembers. The alternative is every handler having to know that the
body is a stream and thread one dict through its own branches, which is a rule
nobody can see from the call site — and this is what happens when they cannot.
"""

import asyncio

import pytest

from conftest import FakeDatabase, FakeRequest, make_env


class OneShotRequest(FakeRequest):
    """A request whose body behaves like the real one: readable once."""

    def __init__(self, payload: dict):
        super().__init__("/api/courses/abc", "PUT", {})
        self.payload = payload
        self.reads = 0

    async def json(self):
        self.reads += 1
        if self.reads > 1:
            raise OSError("Body already used")
        return self.payload


def context(request):
    from shared.responses import Ctx

    return Ctx(make_env(FakeDatabase()), request, "/api/courses/abc", {})


def test_the_second_read_answers_from_the_first():
    request = OneShotRequest({"title": "夜光海浪", "slug": "night-shining-waves"})
    ctx = context(request)

    first = asyncio.run(ctx.json_body())
    second = asyncio.run(ctx.json_body())

    assert first == second == {"title": "夜光海浪", "slug": "night-shining-waves"}
    assert request.reads == 1


def test_something_that_is_not_an_object_is_still_refused_every_time():
    """The check has to survive being remembered: a cached `None` that only
    raised the first time would be a body validated once and trusted after."""

    class NotAnObject(OneShotRequest):
        async def json(self):
            self.reads += 1
            if self.reads > 1:
                raise OSError("Body already used")
            return ["not", "an", "object"]

    ctx = context(NotAnObject({}))

    with pytest.raises(ValueError):
        asyncio.run(ctx.json_body())
    with pytest.raises(ValueError):
        asyncio.run(ctx.json_body())


class TestFormFields:
    """A missing form field is JS `null`, which is not Python `None`.

    `form.get("title")` on a field nobody filled in comes back as the JavaScript
    null — a proxy object that is not `None`, does not raise, and stringifies to
    `jsnull`. Which is how an image ended up in the media library titled
    `jsnull`, twice, with nothing anywhere saying why.
    """

    class Form:
        """A form whose missing fields answer the way the runtime's does."""

        class JsNull:
            def __str__(self):
                return "jsnull"

        def __init__(self, fields):
            self.fields = fields

        def get(self, name):
            return self.fields.get(name, self.JsNull())

    def _read(self, form, name):
        import asyncio

        from api.admin import media as module

        return asyncio.run(module._form_text(form, name))

    def test_a_field_nobody_filled_in_reads_as_empty(self):
        assert self._read(self.Form({}), "title") == ""

    def test_a_field_somebody_did_fill_in_reads_as_itself(self):
        assert self._read(self.Form({"title": "夜光海浪"}), "title") == "夜光海浪"
