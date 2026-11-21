import sys, hashlib
import onnx
from onnx import helper, TensorProto

# A stand-in for the enlarging model, for tests: it repeats every pixel 4 x 4 times
# (nearest-neighbour), with the same input and output names and shapes as the real one.
inp = helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 'height', 'width'])
out = helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 3, 'height_x4', 'width_x4'])
scales = helper.make_tensor('scales', TensorProto.FLOAT, [4], [1.0, 1.0, 4.0, 4.0])
node = helper.make_node('Resize', ['input', '', 'scales'], ['output'], mode='nearest', coordinate_transformation_mode='asymmetric', nearest_mode='floor')
graph = helper.make_graph([node], 'nearest_x4_test_stub', [inp], [out], initializer=[scales])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], producer_name='fvs-design-editor tests')
model.ir_version = 8
onnx.checker.check_model(model)
data = model.SerializeToString()
open(sys.argv[1], 'wb').write(data)
print(len(data), hashlib.sha256(data).hexdigest())
